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
from requests import HTTPError  # type: ignore
from quackosm import PbfFileReader, convert_osm_extract_to_duckdb  # type: ignore
from quackosm.osm_extracts import (  # type: ignore
    OSM_EXTRACT_SOURCE_INDEX_FUNCTION,
    OsmExtractMultipleMatchesError,
    OsmExtractSource,
    OsmExtractZeroMatchesError,
    get_extract_by_query,
)


BATCH_SIZE = 20000
DEFAULT_BUILDING_LEVEL_HEIGHT_METERS = 3.2
DEFAULT_BUILDING_EXTRUSION_LEVELS = 1


def encode_osm_feature_id(osm_type: str, osm_id: int) -> int:
    type_bit = 1 if str(osm_type or '').strip() == 'relation' else 0
    return (int(osm_id) * 2) + type_bit


def normalize_feature_kind(value: Any) -> str:
    kind = str(value or '').strip().lower()
    if kind == 'building_remainder':
        return 'building_remainder'
    return 'building_part' if kind == 'building_part' else 'building'


def derive_feature_kind_from_tags_json(tags_json: str | None) -> str:
    text = str(tags_json or '').strip()
    if not text:
        return 'building'
    try:
        tags = json.loads(text)
    except Exception:
        return 'building'
    if not isinstance(tags, dict):
        return 'building'
    if 'building' in tags:
        return 'building'
    if 'building:part' in tags or 'building_part' in tags:
        return 'building_part'
    return 'building'


def merge_bounds(
    bounds: dict[str, float] | None,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
) -> dict[str, float]:
    if bounds is None:
        return {
            'west': float(min_lon),
            'south': float(min_lat),
            'east': float(max_lon),
            'north': float(max_lat),
        }
    return {
        'west': min(bounds['west'], float(min_lon)),
        'south': min(bounds['south'], float(min_lat)),
        'east': max(bounds['east'], float(max_lon)),
        'north': max(bounds['north'], float(max_lat)),
    }


def round_meter_value(value: Any) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not normalized or normalized < 0:
        return 0.0
    return round(normalized, 2)


def normalize_binary_flag(value: Any) -> int:
    try:
        return 1 if float(value) > 0 else 0
    except (TypeError, ValueError):
        return 0


def parse_tag_number(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace(',', '.')
    match = re.search(r'-?\d+(?:\.\d+)?', normalized)
    if not match:
        return None
    try:
        parsed = float(match.group(0))
    except ValueError:
        return None
    return parsed if parsed == parsed else None


def read_first_numeric_tag(tags: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        if key not in tags:
            continue
        value = parse_tag_number(tags.get(key))
        if value is not None:
            return value
    return None


def build_feature_3d_properties_from_tags(tags: dict[str, Any]) -> dict[str, float]:
    levels = read_first_numeric_tag(tags, ['building:levels', 'levels'])
    explicit_height = read_first_numeric_tag(tags, ['building:height', 'height'])
    min_level = read_first_numeric_tag(tags, ['building:min_level', 'min_level'])
    explicit_min_height = read_first_numeric_tag(tags, ['building:min_height', 'min_height'])
    normalized_levels = levels if levels is not None and levels > 0 else DEFAULT_BUILDING_EXTRUSION_LEVELS
    normalized_explicit_height = explicit_height if explicit_height is not None and explicit_height > 0 else None
    normalized_min_level = min_level if min_level is not None and min_level > 0 else 0
    normalized_explicit_min_height = explicit_min_height if explicit_min_height is not None and explicit_min_height > 0 else 0
    level_derived_min_height = normalized_min_level * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS
    render_min_height_m = max(normalized_explicit_min_height, level_derived_min_height)
    level_derived_height_m = render_min_height_m + (normalized_levels * DEFAULT_BUILDING_LEVEL_HEIGHT_METERS)
    render_height_m = (
        normalized_explicit_height
        if normalized_explicit_height is not None and normalized_explicit_height > render_min_height_m
        else level_derived_height_m
    )
    return {
        'render_height_m': round_meter_value(render_height_m),
        'render_min_height_m': round_meter_value(render_min_height_m),
    }


def build_feature_3d_properties_from_tags_json(tags_json: str | None) -> dict[str, float]:
    text = str(tags_json or '').strip()
    if not text:
        return build_feature_3d_properties_from_tags({})
    try:
        tags = json.loads(text)
    except Exception:
        return build_feature_3d_properties_from_tags({})
    if not isinstance(tags, dict):
        return build_feature_3d_properties_from_tags({})
    return build_feature_3d_properties_from_tags(tags)


def build_geojson_feature_line(
    osm_type: str,
    osm_id: int,
    geometry_json: str,
    tags_json: str | None = None,
    feature_kind: str | None = None,
    render_hide_base_when_parts: int | float | None = None,
) -> str:
    normalized_geometry_json = str(geometry_json or '').strip()
    if not normalized_geometry_json:
        raise ValueError(f'Missing GeoJSON geometry for {str(osm_type or "").strip()}/{int(osm_id)}')
    normalized_feature_kind = normalize_feature_kind(feature_kind or derive_feature_kind_from_tags_json(tags_json))
    feature_3d_properties = build_feature_3d_properties_from_tags_json(tags_json)
    normalized_hide_base_when_parts = normalize_binary_flag(render_hide_base_when_parts)
    return (
        f'{{"type":"Feature","id":{encode_osm_feature_id(osm_type, int(osm_id))},'
        f'"properties":{{"osm_id":{int(osm_id)},"feature_kind":"{normalized_feature_kind}",'
        f'"render_height_m":{feature_3d_properties["render_height_m"]},'
        f'"render_min_height_m":{feature_3d_properties["render_min_height_m"]},'
        f'"render_hide_base_when_parts":{normalized_hide_base_when_parts}}},"geometry":{normalized_geometry_json}}}\n'
    )


def write_export_summary(summary_path: Path, processed: int, imported: int, bounds: dict[str, float] | None) -> None:
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps({
            'processed': int(processed),
            'importedFeatureCount': int(imported),
            'bounds': bounds,
        }, ensure_ascii=False),
        encoding='utf-8',
    )


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


def _is_quackosm_index_rate_limit_error(exc: HTTPError) -> bool:
    response = getattr(exc, 'response', None)
    status_code = getattr(response, 'status_code', None)
    if status_code not in {403, 429}:
        return False

    details = f'{exc} {getattr(response, "text", "")}'.casefold()
    return status_code == 429 or 'rate limit' in details or 'too many requests' in details


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


def _load_extract_index(source: OsmExtractSource) -> Any:
    loader = OSM_EXTRACT_SOURCE_INDEX_FUNCTION[source]
    try:
        return loader()
    except HTTPError as exc:
        if not _is_quackosm_index_rate_limit_error(exc):
            raise

        print(
            'QuackOSM precalculated index download was rate-limited for '
            f'source={source.value}; retrying with local recalculation.',
            file=sys.stderr,
            flush=True,
        )
        return loader(force_recalculation=True)


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
            [
                _load_extract_index(get_source_enum)
                for get_source_enum in OSM_EXTRACT_SOURCE_INDEX_FUNCTION.keys()
            ],
            ignore_index=True,
        )
    else:
        index = _load_extract_index(source_enum)

    index = index.copy()
    index['source_name'] = index['file_name'].map(infer_extract_source)
    index['normalized_name'] = index['name'].map(normalize_search_text)
    index['normalized_file_name'] = index['file_name'].map(normalize_search_text)
    return index


def resolve_exact_extract(query: str, source: str = 'any') -> dict[str, Any]:
    normalized_source = normalize_extract_source(source)
    raw_query = str(query or '').strip()
    if raw_query:
        get_extract_index(normalized_source)
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
        tags_filter={'building': True, 'building:part': True},
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
    normalized_source = normalize_extract_source(extract_source)
    get_extract_index(normalized_source)
    resolved = resolve_exact_extract_alias(resolved_query, normalized_source)
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
        osm_extract_source=normalized_source,
        tags_filter={'building': True, 'building:part': True},
        result_file_path=duckdb_path,
        keep_all_tags=True,
        explode_tags=False,
        ignore_cache=False,
        duckdb_table_name='quackosm_raw',
    )
    return duckdb_path


def _filtered_rows_cte_sql(import_limit: int) -> str:
    limit_sql = f'LIMIT {int(import_limit)}' if import_limit > 0 else ''

    return f'''
WITH src_raw AS (
  SELECT
    feature_id,
    CAST(to_json(tags) AS VARCHAR) AS tags_json,
    geometry,
    ST_XMin(geometry) AS min_lon,
    ST_YMin(geometry) AS min_lat,
    ST_XMax(geometry) AS max_lon,
    ST_YMax(geometry) AS max_lat
  FROM quackosm_raw
  WHERE geometry IS NOT NULL
    AND split_part(feature_id, '/', 1) IN ('way', 'relation')
    AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON')
), src AS (
  SELECT
    feature_id,
    tags_json,
    CASE
      WHEN strpos(tags_json, '"building"') > 0 THEN 'building'
      WHEN strpos(tags_json, '"building:part"') > 0 OR strpos(tags_json, '"building_part"') > 0 THEN 'building_part'
      ELSE 'building'
    END AS feature_kind,
    geometry,
    min_lon,
    min_lat,
    max_lon,
    max_lat
  FROM src_raw
), filtered AS (
  SELECT *
  FROM src
  ORDER BY feature_id
  {limit_sql}
), buildings_with_parts AS (
  SELECT DISTINCT building.feature_id
  FROM filtered building
  JOIN filtered part
    ON building.feature_kind = 'building'
   AND part.feature_kind = 'building_part'
   AND part.feature_id <> building.feature_id
   AND part.min_lon >= building.min_lon
   AND part.max_lon <= building.max_lon
   AND part.min_lat >= building.min_lat
   AND part.max_lat <= building.max_lat
), enriched AS (
  SELECT
    filtered.feature_id,
    filtered.tags_json,
    filtered.feature_kind,
    filtered.geometry,
    filtered.min_lon,
    filtered.min_lat,
    filtered.max_lon,
    filtered.max_lat,
    CASE
      WHEN buildings_with_parts.feature_id IS NULL THEN 0
      ELSE 1
    END AS render_hide_base_when_parts
  FROM filtered
  LEFT JOIN buildings_with_parts
    ON buildings_with_parts.feature_id = filtered.feature_id
)
'''


def _remainder_rows_cte_sql(import_limit: int) -> str:
    return f'''
{_filtered_rows_cte_sql(import_limit)}
, building_remainders AS (
  SELECT
    building.feature_id,
    building.tags_json,
    ST_Multi(
      ST_CollectionExtract(
        ST_Difference(
          ST_MakeValid(building.geometry),
          ST_Union_Agg(ST_MakeValid(part.geometry))
        ),
        3
      )
    ) AS geometry
  FROM filtered building
  JOIN filtered part
    ON building.feature_kind = 'building'
   AND part.feature_kind = 'building_part'
   AND part.feature_id <> building.feature_id
   AND part.min_lon >= building.min_lon
   AND part.max_lon <= building.max_lon
   AND part.min_lat >= building.min_lat
   AND part.max_lat <= building.max_lat
  GROUP BY building.feature_id, building.tags_json, building.geometry
), remainder_rows AS (
  SELECT
    feature_id,
    tags_json,
    'building_remainder' AS feature_kind,
    geometry,
    ST_XMin(geometry) AS min_lon,
    ST_YMin(geometry) AS min_lat,
    ST_XMax(geometry) AS max_lon,
    ST_YMax(geometry) AS max_lat,
    0 AS render_hide_base_when_parts
  FROM building_remainders
  WHERE geometry IS NOT NULL
    AND NOT ST_IsEmpty(geometry)
), export_rows AS (
  SELECT
    enriched.feature_id,
    enriched.tags_json,
    enriched.feature_kind,
    enriched.geometry,
    enriched.min_lon,
    enriched.min_lat,
    enriched.max_lon,
    enriched.max_lat,
    enriched.render_hide_base_when_parts
  FROM enriched

  UNION ALL

  SELECT
    remainder_rows.feature_id,
    remainder_rows.tags_json,
    remainder_rows.feature_kind,
    remainder_rows.geometry,
    remainder_rows.min_lon,
    remainder_rows.min_lat,
    remainder_rows.max_lon,
    remainder_rows.max_lat,
    remainder_rows.render_hide_base_when_parts
  FROM remainder_rows
)
'''


def _build_export_select_sql(
    cte_sql: str,
    source_rows_name: str,
    geometry_sql: str,
) -> str:
    return f'''
{cte_sql}
SELECT
  split_part(feature_id, '/', 1) AS osm_type,
  try_cast(split_part(feature_id, '/', 2) AS BIGINT) AS osm_id,
  tags_json,
  feature_kind,
  render_hide_base_when_parts,
  {geometry_sql},
  min_lon,
  min_lat,
  max_lon,
  max_lat
FROM {source_rows_name}
WHERE try_cast(split_part(feature_id, '/', 2) AS BIGINT) IS NOT NULL;
'''


def _export_select_sql(import_limit: int, geometry_mode: str = 'geojson') -> str:
    geometry_mode_normalized = str(geometry_mode or 'geojson').strip().lower() or 'geojson'
    if geometry_mode_normalized == 'wkb_hex':
        geometry_sql = 'ST_AsHEXWKB(geometry) AS geometry_wkb_hex'
        return _build_export_select_sql(_filtered_rows_cte_sql(import_limit), 'enriched', geometry_sql)
    elif geometry_mode_normalized in ('geojson', 'geojson_feature'):
        geometry_sql = 'ST_AsGeoJSON(geometry) AS geometry_json'
        source_rows_name = 'export_rows' if geometry_mode_normalized == 'geojson_feature' else 'enriched'
        cte_sql = _remainder_rows_cte_sql(import_limit) if geometry_mode_normalized == 'geojson_feature' else _filtered_rows_cte_sql(import_limit)
        return _build_export_select_sql(cte_sql, source_rows_name, geometry_sql)
    else:
        raise ValueError(f'Unsupported geometry export mode: {geometry_mode}')


def _export_remainder_select_sql(import_limit: int) -> str:
    return _build_export_select_sql(
        _remainder_rows_cte_sql(import_limit),
        'remainder_rows',
        'ST_AsGeoJSON(geometry) AS geometry_json',
    )


def _export_dual_select_sql(import_limit: int) -> str:
    return _build_export_select_sql(
        _filtered_rows_cte_sql(import_limit),
        'enriched',
        'ST_AsHEXWKB(geometry) AS geometry_wkb_hex, ST_AsGeoJSON(geometry) AS geometry_json',
    )


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
    select_sql = _export_select_sql(import_limit, 'geojson')

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
    geometry_mode: str = 'geojson',
    append: bool = False,
) -> Tuple[int, int, dict[str, float] | None]:
    geometry_mode_normalized = str(geometry_mode or 'geojson').strip().lower() or 'geojson'
    select_sql = _export_select_sql(import_limit, geometry_mode_normalized)
    mode = 'a' if append else 'w'
    processed = 0
    imported = 0
    bounds: dict[str, float] | None = None

    with duckdb.connect(str(duckdb_path)) as con:
        _load_duckdb_extensions(con)
        cursor = con.execute(select_sql)
        with out_path.open(mode, encoding='utf-8') as out:
            while True:
                chunk = cursor.fetchmany(BATCH_SIZE)
                if not chunk:
                    break
                for row in chunk:
                    if geometry_mode_normalized == 'wkb_hex':
                        payload = {
                            'osm_type': row[0],
                            'osm_id': int(row[1]),
                            'tags_json': row[2],
                            'feature_kind': normalize_feature_kind(row[3]),
                            'render_hide_base_when_parts': normalize_binary_flag(row[4]),
                            'min_lon': float(row[6]),
                            'min_lat': float(row[7]),
                            'max_lon': float(row[8]),
                            'max_lat': float(row[9]),
                        }
                        payload['geometry_wkb_hex'] = str(row[5])
                        out.write(json.dumps(payload, ensure_ascii=False))
                        out.write('\n')
                    elif geometry_mode_normalized == 'geojson_feature':
                        out.write(build_geojson_feature_line(
                            str(row[0]),
                            int(row[1]),
                            str(row[5]),
                            str(row[2]),
                            str(row[3]),
                            row[4],
                        ))
                    else:
                        payload = {
                            'osm_type': row[0],
                            'osm_id': int(row[1]),
                            'tags_json': row[2],
                            'feature_kind': normalize_feature_kind(row[3]),
                            'render_hide_base_when_parts': normalize_binary_flag(row[4]),
                            'min_lon': float(row[6]),
                            'min_lat': float(row[7]),
                            'max_lon': float(row[8]),
                            'max_lat': float(row[9]),
                        }
                        payload['geometry_json'] = row[5]
                        out.write(json.dumps(payload, ensure_ascii=False))
                        out.write('\n')
                    processed += 1
                    imported += 1
                    bounds = merge_bounds(bounds, float(row[6]), float(row[7]), float(row[8]), float(row[9]))

    return processed, imported, bounds


def export_rows_duckdb_dual_ndjson(
    duckdb_path: Path,
    db_out_path: Path,
    geojson_out_path: Path,
    import_limit: int,
    append: bool = False,
) -> Tuple[int, int, dict[str, float] | None]:
    select_sql = _export_dual_select_sql(import_limit)
    mode = 'a' if append else 'w'
    processed = 0
    imported = 0
    bounds: dict[str, float] | None = None

    with duckdb.connect(str(duckdb_path)) as con:
        _load_duckdb_extensions(con)
        cursor = con.execute(select_sql)
        with db_out_path.open(mode, encoding='utf-8') as db_out, geojson_out_path.open(mode, encoding='utf-8') as geojson_out:
            while True:
                chunk = cursor.fetchmany(BATCH_SIZE)
                if not chunk:
                    break
                for row in chunk:
                    osm_type = str(row[0])
                    osm_id = int(row[1])
                    min_lon = float(row[7])
                    min_lat = float(row[8])
                    max_lon = float(row[9])
                    max_lat = float(row[10])

                    db_out.write(json.dumps({
                        'osm_type': osm_type,
                        'osm_id': osm_id,
                        'tags_json': row[2],
                        'feature_kind': normalize_feature_kind(row[3]),
                        'render_hide_base_when_parts': normalize_binary_flag(row[4]),
                        'geometry_wkb_hex': str(row[5]),
                        'min_lon': min_lon,
                        'min_lat': min_lat,
                        'max_lon': max_lon,
                        'max_lat': max_lat,
                    }, ensure_ascii=False))
                    db_out.write('\n')

                    geojson_out.write(build_geojson_feature_line(
                        osm_type,
                        osm_id,
                        str(row[6]),
                        str(row[2]),
                        str(row[3]),
                        row[4],
                    ))

                    processed += 1
                    imported += 1
                    bounds = merge_bounds(bounds, min_lon, min_lat, max_lon, max_lat)

            remainder_cursor = con.execute(_export_remainder_select_sql(import_limit))
            while True:
                chunk = remainder_cursor.fetchmany(BATCH_SIZE)
                if not chunk:
                    break
                for row in chunk:
                    min_lon = float(row[6])
                    min_lat = float(row[7])
                    max_lon = float(row[8])
                    max_lat = float(row[9])
                    geojson_out.write(build_geojson_feature_line(
                        str(row[0]),
                        int(row[1]),
                        str(row[5]),
                        str(row[2]),
                        str(row[3]),
                        row[4],
                    ))
                    processed += 1
                    imported += 1
                    bounds = merge_bounds(bounds, min_lon, min_lat, max_lon, max_lat)

    return processed, imported, bounds


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
    parser.add_argument('--out-db-ndjson', required=False)
    parser.add_argument('--out-geojson-ndjson', required=False)
    parser.add_argument('--out-summary-json', required=False)
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
    out_db_ndjson = str(args.out_db_ndjson or '').strip()
    out_geojson_ndjson = str(args.out_geojson_ndjson or '').strip()
    out_summary_json = str(args.out_summary_json or '').strip()
    if out_ndjson and (out_db_ndjson or out_geojson_ndjson):
        raise ValueError('Use either --out-ndjson or --out-db-ndjson/--out-geojson-ndjson')
    if out_db_ndjson and out_geojson_ndjson:
        db_candidate = Path(out_db_ndjson).expanduser().resolve()
        geojson_candidate = Path(out_geojson_ndjson).expanduser().resolve()
        if db_candidate == geojson_candidate:
            raise ValueError('--out-db-ndjson and --out-geojson-ndjson must point to different files')

    conn = None
    run_marker = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')
    if not out_ndjson and not out_db_ndjson and not out_geojson_ndjson:
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
    export_bounds: dict[str, float] | None = None
    ndjson_path = Path(out_ndjson).expanduser().resolve() if out_ndjson else None
    db_ndjson_path = Path(out_db_ndjson).expanduser().resolve() if out_db_ndjson else None
    geojson_ndjson_path = Path(out_geojson_ndjson).expanduser().resolve() if out_geojson_ndjson else None
    summary_json_path = Path(out_summary_json).expanduser().resolve() if out_summary_json else None
    for candidate_path in (ndjson_path, db_ndjson_path, geojson_ndjson_path, summary_json_path):
        if candidate_path is not None:
            candidate_path.parent.mkdir(parents=True, exist_ok=True)
            if candidate_path.exists():
                candidate_path.unlink()

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
                p, i, bounds = export_rows_duckdb_ndjson(
                    duckdb_path=duckdb_path,
                    out_path=ndjson_path,
                    import_limit=per_query_limit,
                    geometry_mode='geojson',
                    append=(idx > 1),
                )
            elif db_ndjson_path is not None or geojson_ndjson_path is not None:
                if db_ndjson_path is not None and geojson_ndjson_path is not None:
                    p, i, bounds = export_rows_duckdb_dual_ndjson(
                        duckdb_path=duckdb_path,
                        db_out_path=db_ndjson_path,
                        geojson_out_path=geojson_ndjson_path,
                        import_limit=per_query_limit,
                        append=(idx > 1),
                    )
                elif db_ndjson_path is not None:
                    p, i, bounds = export_rows_duckdb_ndjson(
                        duckdb_path=duckdb_path,
                        out_path=db_ndjson_path,
                        import_limit=per_query_limit,
                        geometry_mode='wkb_hex',
                        append=(idx > 1),
                    )
                else:
                    p, i, bounds = export_rows_duckdb_ndjson(
                        duckdb_path=duckdb_path,
                        out_path=geojson_ndjson_path,
                        import_limit=per_query_limit,
                        geometry_mode='geojson_feature',
                        append=(idx > 1),
                    )
            else:
                p, i = import_rows_direct_duckdb_sqlite(
                    duckdb_path=duckdb_path,
                    sqlite_conn=conn,
                    import_limit=per_query_limit,
                    run_marker=run_marker,
                )
                bounds = None
            processed += p
            imported += i
            if bounds is not None:
                export_bounds = merge_bounds(
                    export_bounds,
                    bounds['west'],
                    bounds['south'],
                    bounds['east'],
                    bounds['north'],
                )
    else:
        print(f'PBF import started (QuackOSM + DuckDB): {pbf_path}', flush=True)
        duckdb_path = run_quackosm_to_duckdb(pbf_path, work_dir)
        if ndjson_path is not None:
            processed, imported, export_bounds = export_rows_duckdb_ndjson(
                duckdb_path=duckdb_path,
                out_path=ndjson_path,
                import_limit=import_limit,
                geometry_mode='geojson',
                append=False,
            )
        elif db_ndjson_path is not None or geojson_ndjson_path is not None:
            if db_ndjson_path is not None and geojson_ndjson_path is not None:
                processed, imported, export_bounds = export_rows_duckdb_dual_ndjson(
                    duckdb_path=duckdb_path,
                    db_out_path=db_ndjson_path,
                    geojson_out_path=geojson_ndjson_path,
                    import_limit=import_limit,
                    append=False,
                )
            elif db_ndjson_path is not None:
                processed, imported, export_bounds = export_rows_duckdb_ndjson(
                    duckdb_path=duckdb_path,
                    out_path=db_ndjson_path,
                    import_limit=import_limit,
                    geometry_mode='wkb_hex',
                    append=False,
                )
            else:
                processed, imported, export_bounds = export_rows_duckdb_ndjson(
                    duckdb_path=duckdb_path,
                    out_path=geojson_ndjson_path,
                    import_limit=import_limit,
                    geometry_mode='geojson_feature',
                    append=False,
                )
        else:
            processed, imported = import_rows_direct_duckdb_sqlite(
                duckdb_path=duckdb_path,
                sqlite_conn=conn,
                import_limit=import_limit,
                run_marker=run_marker,
            )

    if ndjson_path is not None or db_ndjson_path is not None or geojson_ndjson_path is not None:
        if summary_json_path is not None:
            write_export_summary(summary_json_path, processed, imported, export_bounds)
        print(
            'Export done. '
            f'processed={processed}, exported={imported}, '
            f'db_ndjson={db_ndjson_path}, geojson_ndjson={geojson_ndjson_path}, ndjson={ndjson_path}',
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
