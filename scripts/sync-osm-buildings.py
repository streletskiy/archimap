import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Tuple

import duckdb  # type: ignore
from quackosm import PbfFileReader, convert_osm_extract_to_duckdb  # type: ignore


BATCH_SIZE = 20000


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


def run_quackosm_extract_to_duckdb(extract_query: str, work_dir: Path, index: int) -> Path:
    safe_slug = ''.join(ch if ch.isalnum() else '-' for ch in extract_query.lower()).strip('-')
    if not safe_slug:
        safe_slug = 'extract'
    duckdb_path = work_dir / f'quackosm-buildings-{index:02d}-{safe_slug[:50]}.duckdb'
    if duckdb_path.exists():
        duckdb_path.unlink()

    query_to_use = extract_query
    for attempt in range(2):
        try:
            convert_osm_extract_to_duckdb(
                osm_extract_query=query_to_use,
                tags_filter={'building': True},
                result_file_path=duckdb_path,
                keep_all_tags=True,
                explode_tags=False,
                ignore_cache=False,
                duckdb_table_name='quackosm_raw',
            )
            return duckdb_path
        except Exception as exc:
            msg = str(exc)
            if attempt == 0 and 'Zero extracts matched by query' in msg:
                match = re.search(r'Found full names close to query:\s*"([^"]+)"', msg)
                if match:
                    suggestion = match.group(1).strip()
                    if suggestion and suggestion.lower() != query_to_use.lower():
                        print(
                            f'No exact extract match for "{extract_query}", retrying with suggested full name: "{suggestion}"',
                            flush=True,
                        )
                        query_to_use = suggestion
                        continue
            raise
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pbf', required=False)
    parser.add_argument('--extract-query', action='append', default=[])
    parser.add_argument('--no-count-pass', action='store_true')
    parser.add_argument('--out-ndjson', required=False)
    args = parser.parse_args()
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
        print(f'Extract query import started (QuackOSM + DuckDB): {extract_queries}', flush=True)
        for idx, query in enumerate(extract_queries, start=1):
            if import_limit > 0 and imported >= import_limit:
                print(f'IMPORT_LIMIT reached: {import_limit}', flush=True)
                break
            print(f'[{idx}/{len(extract_queries)}] Resolving extract: {query}', flush=True)
            duckdb_path = run_quackosm_extract_to_duckdb(query, work_dir, idx)
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
