import argparse
import difflib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Tuple

import duckdb  # type: ignore
import pandas as pd  # type: ignore
from quackosm import PbfFileReader, convert_osm_extract_to_duckdb  # type: ignore
from quackosm.osm_extracts import (  # type: ignore
    OSM_EXTRACT_SOURCE_INDEX_FUNCTION,
    OsmExtractMultipleMatchesError,
    OsmExtractSource,
    OsmExtractZeroMatchesError,
    get_extract_by_query,
)


BATCH_SIZE = 20000


def normalize_extract_source(value: str) -> str:
    raw = str(value or 'any').strip() or 'any'
    try:
        return str(OsmExtractSource(raw).value)
    except ValueError as exc:
        raise ValueError(f'Unknown OSM extract source: {raw}') from exc


def normalize_search_text(value: str) -> str:
    text = str(value or '').strip().casefold()
    text = text.replace('_', ' ')
    text = re.sub(r'[/\\|:;,.()+-]+', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def tokenize_search_text(value: str) -> list[str]:
    return [token for token in normalize_search_text(value).split(' ') if token]


def infer_extract_source(file_name: str) -> str:
    value = str(file_name or '').strip().casefold()
    if value.startswith('osmfr_'):
      return 'osmfr'
    if value.startswith('geofabrik_'):
      return 'geofabrik'
    if value.startswith('bbbike_'):
      return 'bbbike'
    return 'any'


def serialize_extract(extract: Any, *, match_kind: str | None = None, exact: bool | None = None) -> dict[str, Any]:
    file_name = str(getattr(extract, 'file_name', '') or '').strip()
    return {
        'extractSource': infer_extract_source(file_name),
        'extractId': file_name,
        'extractLabel': str(getattr(extract, 'name', '') or file_name).strip() or file_name,
        'downloadUrl': str(getattr(extract, 'url', '') or '').strip() or None,
        'matchKind': match_kind,
        'exact': bool(exact),
    }


def trim_extract_archive_suffix(value: str) -> str:
    text = str(value or '').strip()
    for suffix in ('-latest.osm.pbf', '.osm.pbf', '-latest.pbf', '.pbf'):
        if text.casefold().endswith(suffix):
            return text[: -len(suffix)]
    return text


def normalize_path_alias(value: str) -> str:
    text = str(value or '').strip().replace('\\', '/')
    text = re.sub(r'/+', '/', text)
    return text.strip('/').casefold()


def build_path_aliases_for_row(row: Any) -> set[str]:
    aliases: set[str] = set()
    file_name = str(getattr(row, 'file_name', '') or '').strip()
    source_name = infer_extract_source(file_name)
    url = str(getattr(row, 'url', '') or '').strip()
    if not url:
        return aliases

    parsed = urllib.parse.urlparse(url)
    path = trim_extract_archive_suffix(parsed.path).lstrip('/')
    if source_name == 'osmfr' and path.startswith('extracts/'):
        path = path[len('extracts/') :]

    normalized_path = normalize_path_alias(path)
    if normalized_path:
        aliases.add(normalized_path)

    if source_name == 'geofabrik' and normalized_path:
        parts = [part for part in normalized_path.split('/') if part]
        for start in range(1, len(parts)):
            suffix_alias = '/'.join(parts[start:])
            if suffix_alias:
                aliases.add(suffix_alias)

    return aliases


@lru_cache(maxsize=None)
def get_extract_path_aliases(source: str) -> dict[str, list[str]]:
    index = get_extract_index(source)
    matches: dict[str, list[str]] = {}

    for row in index.itertuples(index=False):
        file_name = str(getattr(row, 'file_name', '') or '').strip()
        if not file_name:
            continue
        for alias in build_path_aliases_for_row(row):
            matches.setdefault(alias, []).append(file_name)

    return matches


def resolve_exact_extract_alias(query: str, source: str = 'any') -> dict[str, Any]:
    normalized_source = normalize_extract_source(source)
    normalized_query = normalize_path_alias(trim_extract_archive_suffix(str(query or '').strip()))
    if not normalized_query:
        return {
            'candidate': None,
            'errorCode': 'not_found',
            'message': 'Empty extract query.',
            'matchingExtractIds': [],
        }

    alias_matches = get_extract_path_aliases(normalized_source).get(normalized_query, [])
    unique_matches = sorted(set(str(item or '').strip() for item in alias_matches if str(item or '').strip()))
    if len(unique_matches) == 1:
        extract = get_extract_by_query(unique_matches[0], source=normalized_source)
        return {
            'candidate': serialize_extract(extract, match_kind='exact_alias', exact=True),
            'errorCode': None,
            'message': None,
            'matchingExtractIds': [],
        }
    if len(unique_matches) > 1:
        return {
            'candidate': None,
            'errorCode': 'multiple',
            'message': (
                f'Extract query "{str(query or "").strip()}" matches multiple canonical extracts. '
                f'Select one manually.'
            ),
            'matchingExtractIds': unique_matches,
        }
    return {
        'candidate': None,
        'errorCode': 'not_found',
        'message': None,
        'matchingExtractIds': [],
    }


@lru_cache(maxsize=None)
def get_extract_index(source: str) -> Any:
    source_name = normalize_extract_source(source)
    source_enum = OsmExtractSource(source_name)
    if source_enum == OsmExtractSource.any:
        index = pd.concat(
            [get_index_function() for get_index_function in OSM_EXTRACT_SOURCE_INDEX_FUNCTION.values()],
            ignore_index=True,
        )
    else:
        index = OSM_EXTRACT_SOURCE_INDEX_FUNCTION[source_enum]()

    index = index.copy()
    index['source_name'] = index['file_name'].map(infer_extract_source)
    index['normalized_name'] = index['name'].map(normalize_search_text)
    index['normalized_file_name'] = index['file_name'].map(normalize_search_text)
    return index


def resolve_exact_extract(query: str, source: str = 'any') -> dict[str, Any]:
    normalized_source = normalize_extract_source(source)
    raw_query = str(query or '').strip()
    if '/' in raw_query or '\\' in raw_query:
        alias_result = resolve_exact_extract_alias(raw_query, normalized_source)
        if alias_result.get('candidate') or alias_result.get('errorCode') == 'multiple':
            return alias_result
    try:
        extract = get_extract_by_query(query, source=normalized_source)
        return {
            'candidate': serialize_extract(extract, match_kind='exact', exact=True),
            'errorCode': None,
            'message': None,
            'matchingExtractIds': [],
        }
    except OsmExtractMultipleMatchesError as exc:
        return {
            'candidate': None,
            'errorCode': 'multiple',
            'message': str(exc),
            'matchingExtractIds': list(getattr(exc, 'matching_full_names', []) or []),
        }
    except OsmExtractZeroMatchesError as exc:
        return {
            'candidate': None,
            'errorCode': 'not_found',
            'message': str(exc),
            'matchingExtractIds': list(getattr(exc, 'matching_full_names', []) or []),
        }


def search_extract_candidates(query: str, source: str = 'any', limit: int = 12) -> dict[str, Any]:
    normalized_source = normalize_extract_source(source)
    normalized_query = normalize_search_text(query)
    query_tokens = set(tokenize_search_text(query))
    if not normalized_query:
        return {
            'query': '',
            'items': [],
        }

    index = get_extract_index(normalized_source)
    ranked: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for row in index.itertuples(index=False):
        normalized_name = str(getattr(row, 'normalized_name', '') or '')
        normalized_file_name = str(getattr(row, 'normalized_file_name', '') or '')
        name_tokens = set(tokenize_search_text(normalized_name))
        file_tokens = set(tokenize_search_text(normalized_file_name))
        overlap = len(query_tokens & name_tokens) + len(query_tokens & file_tokens)
        ratio = max(
            difflib.SequenceMatcher(None, normalized_query, normalized_name).ratio() if normalized_name else 0.0,
            difflib.SequenceMatcher(None, normalized_query, normalized_file_name).ratio() if normalized_file_name else 0.0,
        )

        score = 0
        match_kind = 'fuzzy'
        exact = False

        if normalized_query == normalized_file_name:
            score = 1000
            match_kind = 'exact_file_name'
            exact = True
        elif normalized_query == normalized_name:
            score = 950
            match_kind = 'exact_name'
            exact = True
        elif normalized_query in normalized_file_name:
            score = 820
            match_kind = 'file_name_contains'
        elif normalized_query in normalized_name:
            score = 780
            match_kind = 'name_contains'
        elif query_tokens and (query_tokens <= name_tokens or query_tokens <= file_tokens):
            score = 720 + overlap
            match_kind = 'token_subset'
        elif overlap > 0:
            score = 520 + (overlap * 20) + int(ratio * 100)
            match_kind = 'token_overlap'
        elif ratio >= 0.72:
            score = 320 + int(ratio * 100)
            match_kind = 'fuzzy'

        if score <= 0:
            continue

        extract_id = str(getattr(row, 'file_name', '') or '').strip()
        if not extract_id or extract_id in seen_ids:
            continue
        seen_ids.add(extract_id)

        ranked.append({
            'extractSource': infer_extract_source(extract_id),
            'extractId': extract_id,
            'extractLabel': str(getattr(row, 'name', '') or extract_id).strip() or extract_id,
            'downloadUrl': str(getattr(row, 'url', '') or '').strip() or None,
            'matchKind': match_kind,
            'exact': exact,
            'score': score,
            'area': float(getattr(row, 'area', 0.0) or 0.0),
        })

    ranked.sort(key=lambda item: (-int(item['score']), float(item['area']), str(item['extractId'])))
    items = [
        {
            'extractSource': item['extractSource'],
            'extractId': item['extractId'],
            'extractLabel': item['extractLabel'],
            'downloadUrl': item['downloadUrl'],
            'matchKind': item['matchKind'],
            'exact': item['exact'],
        }
        for item in ranked[: max(1, min(50, int(limit or 12)))]
    ]

    return {
        'query': str(query or '').strip(),
        'items': items,
    }


def ensure_sqlite_schema(conn: sqlite3.Connection) -> None:
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA synchronous=OFF;')
    conn.execute('PRAGMA temp_store=MEMORY;')
    conn.execute('PRAGMA cache_size=-200000;')
    conn.execute('''
CREATE TABLE IF NOT EXISTS building_contours (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (osm_type, osm_id)
);
''')
    conn.execute('''
CREATE INDEX IF NOT EXISTS idx_building_contours_bbox
ON building_contours (min_lon, max_lon, min_lat, max_lat);
''')
    ensure_sqlite_rtree_schema(conn)


def ensure_sqlite_rtree_schema(conn: sqlite3.Connection) -> bool:
    compile_options = [str(row[0]) for row in conn.execute('PRAGMA compile_options').fetchall()]
    if not any('ENABLE_RTREE' in option for option in compile_options):
        print('SQLite R*Tree support is not available (ENABLE_RTREE missing); bbox will use fallback index.', flush=True)
        return False

    conn.execute('''
CREATE VIRTUAL TABLE IF NOT EXISTS building_contours_rtree
USING rtree(
  contour_rowid,
  min_lon, max_lon,
  min_lat, max_lat
);
''')
    conn.execute('''
CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_insert
AFTER INSERT ON building_contours
BEGIN
  INSERT OR REPLACE INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;
''')
    conn.execute('''
CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_update
AFTER UPDATE OF min_lon, max_lon, min_lat, max_lat ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
  INSERT INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.rowid, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;
''')
    conn.execute('''
CREATE TRIGGER IF NOT EXISTS trg_building_contours_rtree_delete
AFTER DELETE ON building_contours
BEGIN
  DELETE FROM building_contours_rtree WHERE contour_rowid = old.rowid;
END;
''')
    return True


def rebuild_sqlite_rtree_if_needed(conn: sqlite3.Connection) -> None:
    if not ensure_sqlite_rtree_schema(conn):
        return

    contour_count = int(conn.execute('SELECT COUNT(*) FROM building_contours').fetchone()[0] or 0)
    rtree_count = int(conn.execute('SELECT COUNT(*) FROM building_contours_rtree').fetchone()[0] or 0)
    has_missing = conn.execute('''
SELECT 1
FROM building_contours bc
LEFT JOIN building_contours_rtree br
  ON br.contour_rowid = bc.rowid
WHERE br.contour_rowid IS NULL
LIMIT 1;
''').fetchone() is not None
    has_orphan = conn.execute('''
SELECT 1
FROM building_contours_rtree br
LEFT JOIN building_contours bc
  ON bc.rowid = br.contour_rowid
WHERE bc.rowid IS NULL
LIMIT 1;
''').fetchone() is not None

    if contour_count != rtree_count or has_missing or has_orphan:
        with conn:
            conn.execute('DELETE FROM building_contours_rtree;')
            conn.execute('''
INSERT INTO building_contours_rtree (contour_rowid, min_lon, max_lon, min_lat, max_lat)
SELECT rowid, min_lon, max_lon, min_lat, max_lat
FROM building_contours;
''')
        rebuilt = int(conn.execute('SELECT COUNT(*) FROM building_contours_rtree').fetchone()[0] or 0)
        print(f'Rebuilt building_contours_rtree: {rebuilt} rows', flush=True)


def migrate_sqlite_schema_for_duckdb(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'building_contours';"
    ).fetchone()
    create_sql = (row[0] if row and row[0] else '') or ''
    if "datetime('now')" not in create_sql:
        return

    print('Applying SQLite schema migration for DuckDB compatibility (building_contours.updated_at default)...', flush=True)
    with conn:
        conn.execute('''
CREATE TABLE IF NOT EXISTS building_contours_new (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (osm_type, osm_id)
);
''')
        conn.execute('''
INSERT OR REPLACE INTO building_contours_new
  (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at)
SELECT
  osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at
FROM building_contours;
''')
        conn.execute('DROP TABLE building_contours;')
        conn.execute('ALTER TABLE building_contours_new RENAME TO building_contours;')
        conn.execute('''
CREATE INDEX IF NOT EXISTS idx_building_contours_bbox
ON building_contours (min_lon, max_lon, min_lat, max_lat);
''')
        ensure_sqlite_rtree_schema(conn)


def run_quackosm_to_duckdb(pbf_path: str, work_dir: Path) -> Path:
    duckdb_path = work_dir / 'quackosm-buildings.duckdb'
    if duckdb_path.exists():
        duckdb_path.unlink()

    reader = PbfFileReader(
        tags_filter={'building': True},
        working_directory=work_dir,
        verbosity_mode='transient'
    )

    reader.convert_pbf_to_duckdb(
        pbf_path=pbf_path,
        result_file_path=duckdb_path,
        keep_all_tags=True,
        explode_tags=False,
        ignore_cache=True,
        duckdb_table_name='quackosm_raw'
    )
    return duckdb_path


def run_quackosm_extract_to_duckdb(extract_query: str, extract_source: str, work_dir: Path, index: int) -> Path:
    resolved_query = str(extract_query or '').strip()
    resolved = resolve_exact_extract_alias(resolved_query, extract_source)
    if resolved.get('candidate'):
        resolved_query = str(resolved['candidate'].get('extractId') or resolved_query).strip() or resolved_query

    safe_slug = ''.join(ch if ch.isalnum() else '-' for ch in resolved_query.lower()).strip('-')
    if not safe_slug:
        safe_slug = 'extract'
    duckdb_path = work_dir / f'quackosm-buildings-{index:02d}-{safe_slug[:50]}.duckdb'
    if duckdb_path.exists():
        duckdb_path.unlink()

    convert_osm_extract_to_duckdb(
        osm_extract_query=resolved_query,
        osm_extract_source=normalize_extract_source(extract_source),
        tags_filter={'building': True},
        result_file_path=duckdb_path,
        keep_all_tags=True,
        explode_tags=False,
        ignore_cache=False,
        duckdb_table_name='quackosm_raw',
    )
    return duckdb_path


def _import_select_sql(
    import_limit: int,
) -> str:
    limit_sql = f'LIMIT {int(import_limit)}' if import_limit > 0 else ''

    return f'''
WITH src AS (
  SELECT
    feature_id,
    tags,
    geometry,
    ST_XMin(geometry) AS min_lon,
    ST_YMin(geometry) AS min_lat,
    ST_XMax(geometry) AS max_lon,
    ST_YMax(geometry) AS max_lat
  FROM quackosm_raw
  WHERE geometry IS NOT NULL
    AND split_part(feature_id, '/', 1) IN ('way', 'relation')
    AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON')
), filtered AS (
  SELECT *
  FROM src
  ORDER BY feature_id
  {limit_sql}
)
SELECT
  split_part(feature_id, '/', 1) AS osm_type,
  try_cast(split_part(feature_id, '/', 2) AS BIGINT) AS osm_id,
  CAST(to_json(tags) AS VARCHAR) AS tags_json,
  ST_AsGeoJSON(geometry) AS geometry_json,
  min_lon,
  min_lat,
  max_lon,
  max_lat
FROM filtered
WHERE try_cast(split_part(feature_id, '/', 2) AS BIGINT) IS NOT NULL;
'''


def _load_duckdb_extensions(con: duckdb.DuckDBPyConnection) -> None:
    for ext in ('spatial',):
        try:
            con.load_extension(ext)
        except Exception:
            con.install_extension(ext)
            con.load_extension(ext)


def import_rows_direct_duckdb_sqlite(
    duckdb_path: Path,
    sqlite_conn: sqlite3.Connection,
    import_limit: int,
    run_marker: str,
) -> Tuple[int, int]:
    started_at = time.time()
    select_sql = _import_select_sql(import_limit)

    with duckdb.connect(str(duckdb_path)) as con:
        _load_duckdb_extensions(con)
        con.execute(f'CREATE OR REPLACE TEMP TABLE import_rows AS {select_sql}')
        imported = int(con.execute('SELECT COUNT(*) FROM import_rows').fetchone()[0] or 0)
        processed = imported
        if imported == 0:
            print('Progress: imported=0, processed=0, rate=0 rows/s', flush=True)
            return 0, 0

        sqlite_conn.execute('BEGIN')
        try:
            sqlite_conn.execute('''
CREATE TEMP TABLE IF NOT EXISTS _import_rows_tmp (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  tags_json TEXT,
  geometry_json TEXT NOT NULL,
  min_lon REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lon REAL NOT NULL,
  max_lat REAL NOT NULL
);
''')
            sqlite_conn.execute('DELETE FROM _import_rows_tmp;')

            insert_tmp_sql = '''
INSERT INTO _import_rows_tmp
  (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);
'''
            cursor = con.execute('''
SELECT osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat
FROM import_rows
''')
            while True:
                chunk = cursor.fetchmany(BATCH_SIZE)
                if not chunk:
                    break
                sqlite_conn.executemany(insert_tmp_sql, chunk)

            sqlite_conn.execute('''
DELETE FROM building_contours
WHERE EXISTS (
  SELECT 1
  FROM _import_rows_tmp src
  WHERE src.osm_type = building_contours.osm_type
    AND src.osm_id = building_contours.osm_id
);
''')

            sqlite_conn.execute('''
INSERT INTO building_contours
  (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at)
SELECT
  osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, ?
FROM _import_rows_tmp;
''', (run_marker,))
            sqlite_conn.execute('COMMIT')
        except Exception:
            sqlite_conn.execute('ROLLBACK')
            raise

        elapsed = max(0.001, time.time() - started_at)
        rate = imported / elapsed
        if import_limit > 0:
            left = max(0, import_limit - imported)
            eta_min = left / max(rate, 0.001) / 60.0
            print(
                f'Progress: imported={imported}/{import_limit}, left~{left}, '
                f'processed={processed}, rate={rate:.0f} rows/s, eta={eta_min:.1f} min',
                flush=True,
            )
        else:
            print(f'Progress: imported={imported}, processed={processed}, rate={rate:.0f} rows/s', flush=True)

        return processed, imported


def export_rows_duckdb_ndjson(
    duckdb_path: Path,
    out_path: Path,
    import_limit: int,
    append: bool = False,
) -> Tuple[int, int]:
    select_sql = _import_select_sql(import_limit)
    mode = 'a' if append else 'w'
    processed = 0
    imported = 0

    with duckdb.connect(str(duckdb_path)) as con:
        _load_duckdb_extensions(con)
        cursor = con.execute(select_sql)
        with out_path.open(mode, encoding='utf-8') as out:
            while True:
                chunk = cursor.fetchmany(BATCH_SIZE)
                if not chunk:
                    break
                for row in chunk:
                    payload = {
                        'osm_type': row[0],
                        'osm_id': int(row[1]),
                        'tags_json': row[2],
                        'geometry_json': row[3],
                        'min_lon': float(row[4]),
                        'min_lat': float(row[5]),
                        'max_lon': float(row[6]),
                        'max_lat': float(row[7]),
                    }
                    out.write(json.dumps(payload, ensure_ascii=False))
                    out.write('\n')
                    processed += 1
                    imported += 1

    return processed, imported


def cleanup_stale(conn: sqlite3.Connection, import_limit: int, run_marker: str) -> int:
    if import_limit > 0:
        print('IMPORT_LIMIT active, deletion of stale buildings skipped.', flush=True)
        return 0

    cur = conn.execute('''
DELETE FROM building_contours
WHERE updated_at <> ?;
''', (run_marker,))
    return cur.rowcount if cur.rowcount is not None else 0


def print_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write('\n')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pbf', required=False)
    parser.add_argument('--extract-query', action='append', default=[])
    parser.add_argument('--extract-source', default='any')
    parser.add_argument('--resolve-extract-query', required=False)
    parser.add_argument('--resolve-exact-extract', required=False)
    parser.add_argument('--no-count-pass', action='store_true')
    parser.add_argument('--out-ndjson', required=False)
    parser.add_argument('--limit', type=int, default=12)
    args = parser.parse_args()

    if args.resolve_extract_query is not None:
        print_json(search_extract_candidates(
            query=args.resolve_extract_query,
            source=args.extract_source,
            limit=args.limit,
        ))
        return

    if args.resolve_exact_extract is not None:
        print_json(resolve_exact_extract(
            query=args.resolve_exact_extract,
            source=args.extract_source,
        ))
        return

    extract_queries = list(args.extract_query or [])
    dedup = []
    seen = set()
    for q in extract_queries:
        key = q.lower().strip()
        if not key or key in seen:
            continue
        seen.add(key)
        dedup.append(q.strip())
    extract_queries = dedup

    extract_source = normalize_extract_source(args.extract_source)
    pbf_path = (args.pbf or '').strip()
    if not pbf_path and not extract_queries:
        raise ValueError('Either --pbf or --extract-query must be provided')
    if pbf_path and not os.path.exists(pbf_path):
        raise FileNotFoundError(pbf_path)

    import_limit = int(os.getenv('IMPORT_LIMIT', '0') or '0')
    progress_every = int(os.getenv('PBF_PROGRESS_EVERY', '10000') or '10000')
    with_count_pass = str(os.getenv('PBF_PROGRESS_COUNT_PASS', 'true')).strip().lower() == 'true'
    if args.no_count_pass:
        with_count_pass = False

    out_ndjson = str(args.out_ndjson or '').strip()
    conn = None
    run_marker = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')
    if not out_ndjson:
        db_path = str((Path(os.getenv('OSM_DB_PATH', '')).expanduser().resolve()) if os.getenv('OSM_DB_PATH') else (Path(os.path.dirname(__file__)) / '..' / 'data' / 'osm.db').resolve())
        conn = sqlite3.connect(db_path)
        ensure_sqlite_schema(conn)
        migrate_sqlite_schema_for_duckdb(conn)

    print(
        f'Progress settings: every={progress_every}, count_pass={with_count_pass} (count_pass ignored for QuackOSM)',
        flush=True,
    )
    print('City filter: disabled (removed from importer)', flush=True)

    work_dir = Path(os.path.dirname(__file__)).resolve().parent / 'data' / 'quackosm'
    work_dir.mkdir(parents=True, exist_ok=True)

    processed = 0
    imported = 0
    ndjson_path = Path(out_ndjson).expanduser().resolve() if out_ndjson else None
    if ndjson_path is not None:
        ndjson_path.parent.mkdir(parents=True, exist_ok=True)
        if ndjson_path.exists():
            ndjson_path.unlink()

    if extract_queries:
        print(f'Extract import started (QuackOSM + DuckDB): source={extract_source}, queries={extract_queries}', flush=True)
        for idx, query in enumerate(extract_queries, start=1):
            if import_limit > 0 and imported >= import_limit:
                print(f'IMPORT_LIMIT reached: {import_limit}', flush=True)
                break
            print(f'[{idx}/{len(extract_queries)}] Loading extract: source={extract_source}, id={query}', flush=True)
            duckdb_path = run_quackosm_extract_to_duckdb(query, extract_source, work_dir, idx)
            per_query_limit = max(0, import_limit - imported) if import_limit > 0 else 0
            if ndjson_path is not None:
                p, i = export_rows_duckdb_ndjson(
                    duckdb_path=duckdb_path,
                    out_path=ndjson_path,
                    import_limit=per_query_limit,
                    append=(idx > 1),
                )
            else:
                p, i = import_rows_direct_duckdb_sqlite(
                    duckdb_path=duckdb_path,
                    sqlite_conn=conn,
                    import_limit=per_query_limit,
                    run_marker=run_marker,
                )
            processed += p
            imported += i
    else:
        print(f'PBF import started (QuackOSM + DuckDB): {pbf_path}', flush=True)
        duckdb_path = run_quackosm_to_duckdb(pbf_path, work_dir)
        if ndjson_path is not None:
            processed, imported = export_rows_duckdb_ndjson(
                duckdb_path=duckdb_path,
                out_path=ndjson_path,
                import_limit=import_limit,
                append=False,
            )
        else:
            processed, imported = import_rows_direct_duckdb_sqlite(
                duckdb_path=duckdb_path,
                sqlite_conn=conn,
                import_limit=import_limit,
                run_marker=run_marker,
            )

    if ndjson_path is not None:
        print(
            f'Export done. processed={processed}, exported={imported}, ndjson={ndjson_path}',
            flush=True,
        )
        return

    deleted = cleanup_stale(conn, import_limit, run_marker)
    rebuild_sqlite_rtree_if_needed(conn)
    conn.commit()

    row = conn.execute('SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated FROM building_contours').fetchone()
    total = row[0] if row else 0
    last_updated = row[1] if row else None

    print(
        f'Sync done. processed={processed}, imported={imported}, '
        f'deleted={deleted}, total_in_db={total}, last_updated={last_updated}',
        flush=True,
    )


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Interrupted', flush=True)
        sys.exit(130)
