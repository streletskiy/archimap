from __future__ import annotations

import json
import re
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union


REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / 'frontend' / 'static' / 'admin-regions.geojson'
NATURAL_EARTH_URL = 'https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries.zip'
NATURAL_EARTH_ADMIN1_URL = 'https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip'
GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
OSMFR_POLYGONS_ROOT = 'https://download.openstreetmap.fr/polygons/'
OSMFR_RUSSIA_ROOT = 'https://download.openstreetmap.fr/polygons/russia/'

EXCLUDED_COUNTRY_IDS = {'us', 'russia', 'antarctica'}
COUNTRY_GEOMETRY_FALLBACK_IDS = set()
COUNTRY_HOLE_FILL_IDS = {'kazakhstan'}
COMBINED_COUNTRY_GEOMETRY_IDS = {
    'haiti-and-domrep',
    'israel-and-palestine',
    'senegal-and-gambia',
}
EXTRA_GEOFABRIK_COUNTRY_EXTRACT_IDS = {
    'guernsey-jersey',
}
COUNTRY_ID_ISO_OVERRIDES = {
    'kosovo': 'XK',
}
US_TERRITORY_IDS = {'us/us-virgin-islands'}
EXTRA_COUNTRY_EXTRACTS = {
    'AX': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_europe_finland_aland',
        'name': 'Aland Islands',
    },
    'KW': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_asia_kuwait',
        'name': 'Kuwait',
    },
    'FK': {
        'extract_source': 'geofabrik',
        'extract_id': 'geofabrik_europe_united-kingdom_falklands',
        'name': 'Falkland Islands',
    },
    'OM': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_asia_oman',
        'name': 'Oman',
    },
    'SA': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_asia_saudi_arabia',
        'name': 'Saudi Arabia',
    },
    'QA': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_asia_qatar',
        'name': 'Qatar',
    },
    'TT': {
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_central-america_trinidad_and_tobago',
        'name': 'Trinidad and Tobago',
    },
}
EXTRA_POLY_EXTRACT_FEATURES = (
    {
        'slug': 'lesser-antilles',
        'name': 'Lesser Antilles',
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_central-america_caribbean',
        'poly_path': 'central-america/caribbean',
        'region_kind': 'extract_region',
        'geometry_source': 'osmfr-poly',
    },
    {
        'slug': 'saint-denis-reunion',
        'name': 'Saint-Denis, Reunion',
        'extract_source': 'osmfr',
        'extract_id': 'osmfr_africa_reunion',
        'poly_path': 'africa/reunion',
        'region_kind': 'extract_region',
        'geometry_source': 'osmfr-poly',
        'iso2': 'RE',
    },
)
HTTP_HEADERS = {'User-Agent': 'archimap-admin-regions-builder/1.0'}
HREF_RE = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
SIMPLIFY_TOLERANCE = 0.01
RUSSIA_ADMIN1_OVERRIDES = {
    'russia/siberian_federal_district/altai_krai': 'RU-ALT',
    'russia/siberian_federal_district/altai_republic': 'RU-AL',
    'russia/central_federal_district/moscow': 'RU-MOS',
    'russia/central_federal_district/moscow_oblast': 'RU-MOW',
}
RUSSIA_ADMIN1_COMBINED_FEATURES = (
    {
        'slug': 'ru-crimean-fed-district',
        'name': 'RU Russia Crimean Federal District',
        'extract_source': 'geofabrik',
        'extract_id': 'russia/crimean-fed-district',
        'geometry_source': 'natural-earth-admin1-union',
        'region_kind': 'ru_region',
        'iso2': 'RU',
        'match_paths': (
            'russia/southern_federal_district/crimea_republic',
            'russia/southern_federal_district/sevastopol',
        ),
    },
)
RUSSIA_ADMIN1_COMBINED_MATCH_PATHS = {
    path
    for feature in RUSSIA_ADMIN1_COMBINED_FEATURES
    for path in feature['match_paths']
}


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode('utf-8', errors='replace')


def normalize_text(value: str) -> str:
    text = unicodedata.normalize('NFKD', str(value or ''))
    text = ''.join(char for char in text if not unicodedata.combining(char))
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', ' ', text)
    return text.strip()


def tokenize(value: str) -> set[str]:
    return {token for token in normalize_text(value).split() if token}


def similarity_score(left: str, right: str) -> float:
    left_norm = normalize_text(left)
    right_norm = normalize_text(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 100.0

    left_tokens = tokenize(left_norm)
    right_tokens = tokenize(right_norm)
    intersection = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    score = (intersection / union) * 10 if union else 0.0
    if left_norm in right_norm or right_norm in left_norm:
        score += 20.0
    return score


def slugify(value: str) -> str:
    return re.sub(r'-+', '-', normalize_text(value).replace(' ', '-')).strip('-')


def humanize_segment(segment: str) -> str:
    return ' '.join(part.capitalize() for part in re.split(r'[-_]+', str(segment or '').strip()) if part)


def humanize_path(path: str) -> str:
    return ' '.join(humanize_segment(segment) for segment in str(path or '').split('/') if segment)


def simplify_geometry(geometry: dict | None) -> dict | None:
    if geometry is None:
        return None
    parsed = shape(geometry) if isinstance(geometry, dict) else geometry
    return mapping(parsed.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True))


def fill_polygon_holes(geometry):
    if geometry is None:
        return None

    parsed = shape(geometry) if isinstance(geometry, dict) else geometry
    if isinstance(parsed, Polygon):
        return Polygon(parsed.exterior)
    if isinstance(parsed, MultiPolygon):
        polygons = [Polygon(polygon.exterior) for polygon in parsed.geoms if not polygon.is_empty]
        if not polygons:
            return parsed
        if len(polygons) == 1:
            return polygons[0]
        return MultiPolygon(polygons)
    return parsed


def maybe_fill_country_holes(extract_id: str, geometry):
    if str(extract_id or '').strip().lower() not in COUNTRY_HOLE_FILL_IDS:
        return geometry
    return fill_polygon_holes(geometry)


def parse_poly(text: str):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    polygons: list[list[list[list[float]]]] = []
    index = 1

    while index < len(lines):
        marker = lines[index]
        if marker == 'END':
            break

        is_hole = marker.startswith('!')
        ring: list[list[float]] = []
        index += 1
        while index < len(lines) and lines[index] != 'END':
            lon, lat, *_ = lines[index].split()
            ring.append([float(lon), float(lat)])
            index += 1

        if not ring:
            raise ValueError(f'Empty ring in poly content: {marker}')
        if ring[0] != ring[-1]:
            ring.append(ring[0])

        if is_hole:
            polygons[-1].append(ring)
        else:
            polygons.append([ring])

        index += 1

    if not polygons:
        raise ValueError('No polygons found in poly file')

    if len(polygons) == 1:
        return Polygon(polygons[0][0], polygons[0][1:])
    return MultiPolygon([(rings[0], rings[1:]) for rings in polygons])


@lru_cache(maxsize=1)
def crawl_osmfr_russia_leaf_paths() -> list[str]:
    seen = set()
    queue = deque([OSMFR_RUSSIA_ROOT])
    poly_paths: list[str] = []

    while queue:
        url = queue.popleft()
        if url in seen:
            continue
        seen.add(url)

        html = fetch_text(url)
        for href in HREF_RE.findall(html):
            if href in {'../', './'}:
                continue
            absolute_url = urllib.parse.urljoin(url, href)
            if not absolute_url.startswith(OSMFR_RUSSIA_ROOT):
                continue
            if href.endswith('/'):
                queue.append(absolute_url)
            elif href.endswith('.poly'):
                path = urllib.parse.urlparse(absolute_url).path.split('/polygons/', 1)[1][:-5]
                poly_paths.append(path)

    unique_paths = sorted(set(poly_paths))
    unique_set = set(unique_paths)
    return [
        path for path in unique_paths if not any(other != path and other.startswith(path + '/') for other in unique_set)
    ]


@lru_cache(maxsize=None)
def load_osmfr_poly_geometry(path: str):
    poly_url = urllib.parse.urljoin(OSMFR_POLYGONS_ROOT, f'{path}.poly')
    return parse_poly(fetch_text(poly_url))


def load_natural_earth() -> gpd.GeoDataFrame:
    natural_earth = gpd.read_file(NATURAL_EARTH_URL)
    if natural_earth.crs and str(natural_earth.crs) != 'EPSG:4326':
        natural_earth = natural_earth.to_crs('EPSG:4326')
    return natural_earth


def load_natural_earth_admin1() -> gpd.GeoDataFrame:
    natural_earth_admin1 = gpd.read_file(NATURAL_EARTH_ADMIN1_URL)
    if natural_earth_admin1.crs and str(natural_earth_admin1.crs) != 'EPSG:4326':
        natural_earth_admin1 = natural_earth_admin1.to_crs('EPSG:4326')
    return natural_earth_admin1


def candidate_country_names(row) -> list[str]:
    names = []
    for key in ('NAME_EN', 'NAME', 'ADMIN', 'BRK_NAME', 'NAME_LONG', 'FORMAL_EN', 'SOVEREIGNT'):
        if key in row and row[key]:
            names.append(str(row[key]))
    return names


def select_natural_earth_row(natural_earth: gpd.GeoDataFrame, iso_codes: list[str], geofabrik_name: str):
    candidates = natural_earth[
        natural_earth['ISO_A2'].isin(iso_codes)
        | natural_earth['ISO_A2_EH'].isin(iso_codes)
    ]
    if candidates.empty:
        return None

    target = geofabrik_name or ''
    best_index = None
    best_score = -1.0
    for row_index, row in candidates.iterrows():
        score = max((similarity_score(target, name) for name in candidate_country_names(row)), default=0.0)
        if score > best_score:
            best_score = score
            best_index = row_index

    return candidates.loc[best_index] if best_index is not None else None


def select_natural_earth_rows_by_iso_codes(natural_earth: gpd.GeoDataFrame, iso_codes: list[str]) -> gpd.GeoDataFrame:
    normalized_iso_codes = [str(code).upper() for code in iso_codes if str(code or '').strip()]
    if not normalized_iso_codes:
        return natural_earth.iloc[0:0]

    return natural_earth[
        natural_earth['ISO_A2'].isin(normalized_iso_codes)
        | natural_earth['ISO_A2_EH'].isin(normalized_iso_codes)
    ]


def union_natural_earth_rows(rows: gpd.GeoDataFrame):
    geometries = [row.geometry for _, row in rows.iterrows() if row.geometry is not None and not row.geometry.is_empty]
    if not geometries:
        return None
    return unary_union(geometries)


def select_special_natural_earth_geometry(natural_earth: gpd.GeoDataFrame, extract_id: str):
    normalized_extract_id = str(extract_id or '').strip().lower()
    if normalized_extract_id == 'cyprus':
        cyprus_rows = natural_earth[natural_earth['ADM0_A3_US'].astype(str).str.strip().eq('CYP')]
        if cyprus_rows.empty:
            return None
        return union_natural_earth_rows(cyprus_rows)

    if normalized_extract_id == 'senegal-and-gambia':
        combined_rows = select_natural_earth_rows_by_iso_codes(natural_earth, ['SN', 'GM'])
        if combined_rows.empty:
            return None
        return union_natural_earth_rows(combined_rows)

    if normalized_extract_id == 'israel-and-palestine':
        israel_palestine_rows = select_natural_earth_rows_by_iso_codes(natural_earth, ['IL', 'PS'])
        if israel_palestine_rows.empty:
            return None
        return union_natural_earth_rows(israel_palestine_rows)

    if normalized_extract_id == 'somalia':
        somalia_rows = natural_earth[natural_earth['ADM0_A3_US'].astype(str).str.strip().eq('SOM')]
        if somalia_rows.empty:
            return None
        return union_natural_earth_rows(somalia_rows)

    if normalized_extract_id == 'guernsey-jersey':
        channel_islands_rows = select_natural_earth_rows_by_iso_codes(natural_earth, ['GG', 'JE'])
        if channel_islands_rows.empty:
            return None
        return union_natural_earth_rows(channel_islands_rows)

    return None


def build_country_features(geofabrik_index: dict, natural_earth: gpd.GeoDataFrame) -> list[dict]:
    by_iso_code: defaultdict[str, list[dict]] = defaultdict(list)
    for feature in geofabrik_index.get('features', []):
        properties = feature.get('properties', {})
        geofabrik_id = str(properties.get('id', '')).strip()
        if '/' in geofabrik_id or geofabrik_id in EXCLUDED_COUNTRY_IDS:
            continue
        iso_codes = [str(code).upper() for code in (properties.get('iso3166-1:alpha2') or []) if str(code).strip()]
        if not iso_codes and geofabrik_id in COUNTRY_ID_ISO_OVERRIDES:
            iso_codes = [COUNTRY_ID_ISO_OVERRIDES[geofabrik_id]]
        if not iso_codes:
            continue
        for iso_code in iso_codes:
            by_iso_code[iso_code].append(feature)

    output = []
    seen_extract_ids = set()
    seen_iso_codes = set()
    for iso_code in sorted(by_iso_code):
        candidates = by_iso_code[iso_code]
        scored_candidates = []
        for candidate in candidates:
            properties = candidate.get('properties', {})
            geofabrik_name = str(properties.get('name') or properties.get('id') or '').strip()
            matched_row = select_natural_earth_row(natural_earth, [iso_code], geofabrik_name)
            score = max((similarity_score(geofabrik_name, name) for name in candidate_country_names(matched_row)), default=0.0) \
                if matched_row is not None else 0.0
            scored_candidates.append((score, candidate, matched_row))

        _score, chosen, matched_row = max(scored_candidates, key=lambda item: item[0])

        properties = chosen.get('properties', {})
        extract_id = str(properties.get('id') or '').strip()
        if not extract_id or extract_id in seen_extract_ids:
            continue
        if extract_id in EXCLUDED_COUNTRY_IDS:
            continue

        geofabrik_name = str(properties.get('name') or extract_id).strip()
        iso_alpha2 = iso_code.lower()
        is_combined_extract = extract_id in COMBINED_COUNTRY_GEOMETRY_IDS
        special_natural_earth_geometry = select_special_natural_earth_geometry(natural_earth, extract_id)

        if special_natural_earth_geometry is not None:
            geometry = simplify_geometry(maybe_fill_country_holes(extract_id, special_natural_earth_geometry))
            geometry_source = 'natural-earth'
        elif is_combined_extract or extract_id in COUNTRY_GEOMETRY_FALLBACK_IDS or matched_row is None:
            geometry = simplify_geometry(maybe_fill_country_holes(extract_id, chosen.get('geometry')))
            geometry_source = 'geofabrik-index'
        else:
            geometry = simplify_geometry(maybe_fill_country_holes(extract_id, mapping(matched_row.geometry)))
            geometry_source = 'natural-earth'

        if geometry is None:
            continue

        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': f'{iso_alpha2}-{slugify(extract_id)}',
                'Name': f'{iso_code} {geofabrik_name}',
                'ExtractId': extract_id,
                'ExtractSource': 'geofabrik',
                'GeometrySource': geometry_source,
                'RegionKind': 'country',
                'Iso2': iso_code
            },
            'geometry': geometry
        })
        seen_extract_ids.add(extract_id)
        seen_iso_codes.add(iso_code)

    for iso_code, config in sorted(EXTRA_COUNTRY_EXTRACTS.items()):
        if iso_code in seen_iso_codes:
            continue
        matched_row = select_natural_earth_row(natural_earth, [iso_code], str(config.get('name') or iso_code))
        if matched_row is None:
            raise ValueError(f'No Natural Earth country match found for extra country {iso_code}')

        geometry = simplify_geometry(maybe_fill_country_holes(str(config['extract_id']), mapping(matched_row.geometry)))
        if geometry is None:
            raise ValueError(f'Natural Earth geometry is empty for extra country {iso_code}')

        country_name = str(config.get('name') or matched_row.get('NAME_EN') or matched_row.get('NAME') or iso_code).strip()
        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': f'{iso_code.lower()}-{slugify(country_name)}',
                'Name': f'{iso_code} {country_name}',
                'ExtractId': str(config['extract_id']),
                'ExtractSource': str(config['extract_source']),
                'GeometrySource': 'natural-earth',
                'RegionKind': 'country',
                'Iso2': iso_code
            },
            'geometry': geometry
        })

    return output


def build_extra_geofabrik_country_features(geofabrik_index: dict, natural_earth: gpd.GeoDataFrame) -> list[dict]:
    geofabrik_features_by_id = {
        str(feature.get('properties', {}).get('id') or '').strip(): feature
        for feature in geofabrik_index.get('features', [])
    }

    output = []
    for extract_id in sorted(EXTRA_GEOFABRIK_COUNTRY_EXTRACT_IDS):
        geofabrik_feature = geofabrik_features_by_id.get(extract_id)
        if geofabrik_feature is None:
            raise ValueError(f'No Geofabrik feature found for extra country extract {extract_id}')

        geofabrik_name = str(geofabrik_feature.get('properties', {}).get('name') or extract_id).strip()
        special_natural_earth_geometry = select_special_natural_earth_geometry(natural_earth, extract_id)
        if special_natural_earth_geometry is None:
            raise ValueError(f'No Natural Earth union geometry found for extra country extract {extract_id}')

        geometry = simplify_geometry(maybe_fill_country_holes(extract_id, special_natural_earth_geometry))
        if geometry is None:
            raise ValueError(f'Natural Earth geometry is empty for extra country extract {extract_id}')

        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': slugify(extract_id),
                'Name': geofabrik_name,
                'ExtractId': extract_id,
                'ExtractSource': 'geofabrik',
                'GeometrySource': 'natural-earth',
                'RegionKind': 'country',
            },
            'geometry': geometry
        })

    return output


def build_us_state_features(geofabrik_index: dict, natural_earth: gpd.GeoDataFrame, natural_earth_admin1: gpd.GeoDataFrame) -> list[dict]:
    us_admin1 = natural_earth_admin1[
        (natural_earth_admin1['adm0_a3'] == 'USA')
        & natural_earth_admin1['iso_3166_2'].notna()
    ].copy()
    us_admin1_by_iso = {
        str(row.get('iso_3166_2') or '').strip().upper(): row
        for _, row in us_admin1.iterrows()
        if str(row.get('iso_3166_2') or '').strip()
    }
    puerto_rico_row = select_natural_earth_row(natural_earth, ['PR'], 'Puerto Rico')

    output = []
    for feature in geofabrik_index.get('features', []):
        properties = feature.get('properties', {})
        extract_id = str(properties.get('id', '')).strip()
        iso_codes = [str(code).upper() for code in (properties.get('iso3166-2') or [])]
        if not extract_id.startswith('us/') or extract_id.count('/') != 1:
            continue
        if extract_id in US_TERRITORY_IDS:
            continue
        if not any(code.startswith('US-') for code in iso_codes):
            continue

        iso_code = next((code for code in iso_codes if code.startswith('US-')), '')
        matched_row = us_admin1_by_iso.get(iso_code)
        geometry_source = 'natural-earth-admin1'
        if matched_row is not None:
            geometry = simplify_geometry(mapping(matched_row.geometry))
        elif iso_code == 'US-PR' and puerto_rico_row is not None:
            geometry = simplify_geometry(mapping(puerto_rico_row.geometry))
            geometry_source = 'natural-earth'
        else:
            raise ValueError(f'No Natural Earth US state match found for {extract_id}: {iso_code or "missing ISO code"}')

        if geometry is None:
            raise ValueError(f'Natural Earth US state geometry is empty for {extract_id}')

        state_name = humanize_segment(extract_id.split('/', 1)[1])
        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': f'us-{slugify(extract_id.split("/", 1)[1])}',
                'Name': f'US {state_name}',
                'ExtractId': extract_id,
                'ExtractSource': 'geofabrik',
                'GeometrySource': geometry_source,
                'RegionKind': 'us_state',
                'Iso2': 'US',
                'Iso3166_2': iso_codes[0] if iso_codes else None
            },
            'geometry': geometry
        })
    return output


def build_extra_poly_extract_features() -> list[dict]:
    output = []
    for config in EXTRA_POLY_EXTRACT_FEATURES:
        geometry = simplify_geometry(load_osmfr_poly_geometry(str(config['poly_path'])))
        if geometry is None:
            raise ValueError(f"OSMFR poly geometry is empty for {config['poly_path']}")

        properties = {
            'Slug': str(config['slug']).strip(),
            'Name': str(config['name']).strip(),
            'ExtractId': str(config['extract_id']).strip(),
            'ExtractSource': str(config['extract_source']).strip(),
            'GeometrySource': str(config['geometry_source']).strip(),
            'RegionKind': str(config['region_kind']).strip(),
        }
        if str(config.get('iso2') or '').strip():
            properties['Iso2'] = str(config['iso2']).strip()

        output.append({
            'type': 'Feature',
            'properties': properties,
            'geometry': geometry
        })

    return output


def normalize_russia_admin1_label(value: str) -> str:
    text = normalize_text(value)
    replacements = {
        'saint petersburg': 'st petersburg',
        'st petersburg': 'st petersburg',
        'republic of ': '',
        'autonomous republic of ': '',
        ' autonomous okrug': '',
        ' autonomous oblast': '',
        ' autonomous province': '',
        ' autonomous region': '',
        ' federal city': '',
        ' city of ': '',
        ' oblast': '',
        ' region': '',
        ' republic': '',
        ' territory': '',
        ' alania': '',
        ' yakutia': ' sakha',
        ' jewish': ' yevrey',
        ' oryol': ' orel',
        ' kabardino balkaria': ' kabardino balkar'
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return re.sub(r'\s+', ' ', text).strip()


def score_russia_admin1_row(path: str, row) -> int:
    leaf_name = path.split('/')[-1].replace('_', ' ')
    leaf_normalized = normalize_russia_admin1_label(leaf_name)
    row_names = [str(row.get('name_en') or ''), str(row.get('name') or '')]
    row_normalized = [normalize_russia_admin1_label(name) for name in row_names if name]
    row_type = str(row.get('type_en') or '').strip()

    score = 0
    if leaf_normalized in row_normalized:
        score += 100
    if any(leaf_normalized == item.replace(' krai', '').strip() for item in row_normalized):
        score += 95
    if any(leaf_normalized in item or item in leaf_normalized for item in row_normalized):
        score += 20

    if path.endswith('oblast') and row_type == 'Region':
        score += 10
    if path.endswith('republic') and row_type == 'Republic':
        score += 10
    if path.endswith('krai') and row_type in {'Territory', 'Region'}:
        score += 10
    if path.endswith('autonomous_okrug') and 'Autonomous' in row_type:
        score += 10
    if path.endswith('autonomous_oblast') and 'Autonomous' in row_type:
        score += 10

    if path.endswith('saint_petersburg') and any('petersburg' in item for item in row_normalized):
        score += 80
    if path.endswith('jewish_autonomous_oblast') and any(
        'yevrey' in item or 'jewish' in item for item in row_normalized
    ):
        score += 80
    if path.endswith('sakha_republic') and any('sakha' in item for item in row_normalized):
        score += 80

    return score


def build_russia_admin1_match_map(natural_earth_admin1: gpd.GeoDataFrame) -> dict[str, object]:
    russia_admin1 = natural_earth_admin1[
        (natural_earth_admin1['adm0_a3'] == 'RUS')
        & natural_earth_admin1['name_en'].notna()
    ].copy()
    russia_admin1 = russia_admin1[russia_admin1['name_en'].astype(str).str.strip().ne('None')]

    rows_by_iso = {
        str(row.get('iso_3166_2') or '').strip().upper(): row
        for _, row in russia_admin1.iterrows()
        if str(row.get('iso_3166_2') or '').strip()
    }

    matches = {}
    used_iso_codes: set[str] = set()

    for path in crawl_osmfr_russia_leaf_paths():
        override_iso_code = RUSSIA_ADMIN1_OVERRIDES.get(path)
        if override_iso_code:
            row = rows_by_iso.get(override_iso_code)
            if row is None:
                raise ValueError(f'Natural Earth Admin 1 override not found for {path}: {override_iso_code}')
            matches[path] = row
            used_iso_codes.add(override_iso_code)
            continue

        scored_candidates = []
        for _, row in russia_admin1.iterrows():
            iso_code = str(row.get('iso_3166_2') or '').strip().upper()
            if not iso_code or iso_code in used_iso_codes:
                continue
            score = score_russia_admin1_row(path, row)
            if score > 0:
                scored_candidates.append((score, iso_code, row))

        if not scored_candidates:
            raise ValueError(f'No Natural Earth Admin 1 match found for {path}')

        scored_candidates.sort(key=lambda item: (-item[0], item[1]))
        best_score, best_iso_code, best_row = scored_candidates[0]
        if len(scored_candidates) > 1 and scored_candidates[1][0] == best_score:
            raise ValueError(
                f'Ambiguous Natural Earth Admin 1 match for {path}: '
                f'{best_iso_code} ties with {scored_candidates[1][1]}'
            )

        matches[path] = best_row
        used_iso_codes.add(best_iso_code)

    return matches


def build_russia_region_features(natural_earth_admin1: gpd.GeoDataFrame) -> list[dict]:
    match_map = build_russia_admin1_match_map(natural_earth_admin1)
    output = []
    for config in RUSSIA_ADMIN1_COMBINED_FEATURES:
        rows = [match_map[path] for path in config['match_paths']]
        geometry = simplify_geometry(unary_union([row.geometry for row in rows]))
        if geometry is None:
            raise ValueError(f"Natural Earth Admin 1 union geometry is empty for {config['extract_id']}")

        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': str(config['slug']).strip(),
                'Name': str(config['name']).strip(),
                'ExtractId': str(config['extract_id']).strip(),
                'ExtractSource': str(config['extract_source']).strip(),
                'GeometrySource': str(config['geometry_source']).strip(),
                'RegionKind': str(config['region_kind']).strip(),
                'Iso2': str(config['iso2']).strip(),
            },
            'geometry': geometry
        })

    for path in crawl_osmfr_russia_leaf_paths():
        if path in RUSSIA_ADMIN1_COMBINED_MATCH_PATHS:
            continue
        row = match_map[path]
        parts = [part for part in path.split('/') if part]
        region_name = humanize_segment(parts[-1])
        geometry = simplify_geometry(mapping(row.geometry))
        if geometry is None:
            raise ValueError(f'Natural Earth Admin 1 geometry is empty for {path}')
        output.append({
            'type': 'Feature',
            'properties': {
                'Slug': f'ru-{slugify("-".join(parts[1:]))}',
                'Name': f'RU Russia {region_name}',
                'ExtractId': path,
                'ExtractSource': 'osmfr',
                'GeometrySource': 'natural-earth-admin1',
                'RegionKind': 'ru_region',
                'Iso2': 'RU',
                'Iso3166_2': str(row.get('iso_3166_2') or '').strip() or None
            },
            'geometry': geometry
        })
    return output


def assign_stable_ids(features: list[dict]) -> list[dict]:
    ordered = sorted(
        features,
        key=lambda item: (
            str(item['properties'].get('RegionKind') or ''),
            str(item['properties'].get('ExtractSource') or ''),
            str(item['properties'].get('ExtractId') or '')
        )
    )
    for index, feature in enumerate(ordered, start=1):
        feature['properties']['Id'] = index
    return ordered


def main() -> None:
    geofabrik_index = fetch_json(GEOFABRIK_INDEX_URL)
    natural_earth = load_natural_earth()
    natural_earth_admin1 = load_natural_earth_admin1()

    features = []
    features.extend(build_country_features(geofabrik_index, natural_earth))
    features.extend(build_extra_geofabrik_country_features(geofabrik_index, natural_earth))
    features.extend(build_us_state_features(geofabrik_index, natural_earth, natural_earth_admin1))
    features.extend(build_extra_poly_extract_features())
    features.extend(build_russia_region_features(natural_earth_admin1))
    features = assign_stable_ids(features)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps({'type': 'FeatureCollection', 'features': features}, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8',
        newline='\n'
    )

    print(f'Wrote {len(features)} features to {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
