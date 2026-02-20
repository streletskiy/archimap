import argparse
import json
import os
import sqlite3
import sys
import time

try:
    import osmium  # type: ignore
except Exception as exc:
    print(f'pyosmium import failed: {exc}')
    sys.exit(2)


def parse_city_filters(raw: str):
    raw = (raw or '').strip()
    if not raw:
        return []
    out = []
    for part in [x.strip() for x in raw.split(';') if x.strip()]:
        nums = [float(x.strip()) for x in part.split(',')]
        if len(nums) != 4:
            raise ValueError(f'Invalid CITY_FILTER_BBOXES item: {part}')
        min_lon, min_lat, max_lon, max_lat = nums
        out.append((min_lon, min_lat, max_lon, max_lat))
    return out


def intersects(a, b):
    return a[2] >= b[0] and a[0] <= b[2] and a[3] >= b[1] and a[1] <= b[3]


def ring_bbox(ring):
    min_lon = min(p[0] for p in ring)
    min_lat = min(p[1] for p in ring)
    max_lon = max(p[0] for p in ring)
    max_lat = max(p[1] for p in ring)
    return (min_lon, min_lat, max_lon, max_lat)


class BuildingHandler(osmium.SimpleHandler):
    def __init__(self, conn, city_filters, import_limit, total_items=0, progress_every=200000):
        super().__init__()
        self.conn = conn
        self.city_filters = city_filters
        self.import_limit = import_limit
        self.total_items = int(total_items or 0)
        self.progress_every = max(1000, int(progress_every))
        self.batch = []
        self.batch_size = 1000
        self.processed_items = 0
        self.imported = 0
        self.skipped = 0
        self.started_at = time.time()

        self.upsert_sql = '''
INSERT INTO building_contours (osm_type, osm_id, tags_json, geometry_json, min_lon, min_lat, max_lon, max_lat, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(osm_type, osm_id) DO UPDATE SET
  tags_json = excluded.tags_json,
  geometry_json = excluded.geometry_json,
  min_lon = excluded.min_lon,
  min_lat = excluded.min_lat,
  max_lon = excluded.max_lon,
  max_lat = excluded.max_lat,
  updated_at = datetime('now');
'''

    def flush(self):
        if not self.batch:
            return
        with self.conn:
            self.conn.executemany(self.upsert_sql, self.batch)
            self.conn.executemany(
                'INSERT OR IGNORE INTO temp.sync_present (osm_type, osm_id) VALUES (?, ?);',
                [(row[0], row[1]) for row in self.batch],
            )
        self.batch.clear()

    def _safe_lon_lat(self, node):
        # pyosmium area nodes can expose either lon/lat or location.lon/location.lat
        if hasattr(node, 'lon') and hasattr(node, 'lat'):
            return float(node.lon), float(node.lat)
        if hasattr(node, 'location') and node.location.valid():
            return float(node.location.lon), float(node.location.lat)
        return None

    def _collect_ring(self, ring_obj):
        ring = []
        for node in ring_obj:
            ll = self._safe_lon_lat(node)
            if ll is None:
                return None
            ring.append(ll)
        if len(ring) < 3:
            return None
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        if len(ring) < 4:
            return None
        return ring

    def _build_geometry_from_area(self, area_obj):
        polygons = []
        outer_rings_for_bbox = []

        for outer in area_obj.outer_rings():
            outer_ring = self._collect_ring(outer)
            if not outer_ring:
                continue

            polygon = [outer_ring]
            outer_rings_for_bbox.append(outer_ring)

            if hasattr(area_obj, 'inner_rings'):
                try:
                    for inner in area_obj.inner_rings(outer):
                        inner_ring = self._collect_ring(inner)
                        if inner_ring:
                            polygon.append(inner_ring)
                except Exception:
                    # Keep import robust across pyosmium API differences.
                    pass

            polygons.append(polygon)

        if not polygons:
            return None

        if len(polygons) == 1:
            geom = {'type': 'Polygon', 'coordinates': polygons[0]}
        else:
            geom = {'type': 'MultiPolygon', 'coordinates': polygons}
        return geom, outer_rings_for_bbox

    def _bbox_from_rings(self, rings):
        min_lon = min(pt[0] for ring in rings for pt in ring)
        min_lat = min(pt[1] for ring in rings for pt in ring)
        max_lon = max(pt[0] for ring in rings for pt in ring)
        max_lat = max(pt[1] for ring in rings for pt in ring)
        return (min_lon, min_lat, max_lon, max_lat)

    def area(self, a):
        if a.tags.get('building') is None:
            return
        self.processed_items += 1

        built = self._build_geometry_from_area(a)
        if not built:
            self.skipped += 1
            return
        geometry, rings = built

        bbox = self._bbox_from_rings(rings)
        if self.city_filters and not any(intersects(bbox, f) for f in self.city_filters):
            self.skipped += 1
            return

        tags = {k: v for k, v in a.tags}
        tags['source'] = 'geofabrik-pbf'
        osm_type = 'way' if a.from_way() else 'relation'
        osm_id = int(a.orig_id())

        row = (
            osm_type,
            osm_id,
            json.dumps(tags, ensure_ascii=False),
            json.dumps(geometry, ensure_ascii=False),
            float(bbox[0]),
            float(bbox[1]),
            float(bbox[2]),
            float(bbox[3]),
        )

        self.batch.append(row)
        self.imported += 1

        if len(self.batch) >= self.batch_size:
            self.flush()

        if self.processed_items % self.progress_every == 0:
            elapsed = max(0.001, time.time() - self.started_at)
            rate = self.processed_items / elapsed
            if self.total_items > 0:
                pct = (self.processed_items / self.total_items) * 100.0
                left = max(0, self.total_items - self.processed_items)
                eta_sec = left / max(rate, 0.001)
                print(
                    f'Progress: {self.processed_items}/{self.total_items} ({pct:.1f}%), '
                    f'left~{left}, imported={self.imported}, skipped={self.skipped}, '
                    f'rate={rate:.0f} items/s, eta={eta_sec/60:.1f} min',
                    flush=True
                )
            else:
                print(
                    f'Progress: processed={self.processed_items}, left~n/a, imported={self.imported}, '
                    f'skipped={self.skipped}, rate={rate:.0f} items/s',
                    flush=True
                )

        if self.import_limit > 0 and self.imported >= self.import_limit:
            raise RuntimeError('__IMPORT_LIMIT_REACHED__')


class BuildingCountHandler(osmium.SimpleHandler):
    def __init__(self, progress_every=1000000):
        super().__init__()
        self.total_items = 0
        self.progress_every = max(10000, int(progress_every))

    def way(self, w):
        if w.tags.get('building') is not None:
            self.total_items += 1
            if self.total_items % self.progress_every == 0:
                print(f'Count pass progress: building ways={self.total_items}', flush=True)

    def relation(self, r):
        if r.tags.get('type') == 'multipolygon' and r.tags.get('building') is not None:
            self.total_items += 1
            if self.total_items % self.progress_every == 0:
                print(f'Count pass progress: building entities={self.total_items}', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pbf', required=True)
    parser.add_argument('--no-count-pass', action='store_true')
    args = parser.parse_args()

    pbf_path = args.pbf
    if not os.path.exists(pbf_path):
        raise FileNotFoundError(pbf_path)

    city_filters = parse_city_filters(os.getenv('CITY_FILTER_BBOXES', ''))
    import_limit = int(os.getenv('IMPORT_LIMIT', '0') or '0')
    progress_every = int(os.getenv('PBF_PROGRESS_EVERY', '10000') or '10000')
    with_count_pass = str(os.getenv('PBF_PROGRESS_COUNT_PASS', 'true')).strip().lower() == 'true'
    if args.no_count_pass:
        with_count_pass = False

    db_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'archimap.db')
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL;')
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

    conn.execute('DROP TABLE IF EXISTS temp.sync_present;')
    conn.execute('''
CREATE TEMP TABLE sync_present (
  osm_type TEXT NOT NULL,
  osm_id INTEGER NOT NULL,
  PRIMARY KEY (osm_type, osm_id)
);
''')

    print(
        f'Progress settings: every={progress_every}, count_pass={with_count_pass}',
        flush=True
    )

    if city_filters:
        print(f'City filter enabled: {len(city_filters)} bbox(es)', flush=True)
    else:
        print('City filter disabled: importing full extract', flush=True)

    total_items = 0
    if with_count_pass:
        print('Count pass started (for percentage progress)...', flush=True)
        counter = BuildingCountHandler(progress_every=max(progress_every, 500000))
        try:
            counter.apply_file(pbf_path, locations=False)
            total_items = counter.total_items
            print(f'Count pass done. total_building_entities={total_items}', flush=True)
        except RuntimeError as exc:
            print(f'Count pass failed: {exc}. Continue without percentage progress.', flush=True)
            total_items = 0

    handler = BuildingHandler(
        conn,
        city_filters,
        import_limit,
        total_items=total_items,
        progress_every=progress_every
    )

    print(f'PBF import started: {pbf_path}', flush=True)
    try:
        # area callback requires area builder enabled
        handler.apply_file(pbf_path, locations=True, idx='flex_mem')
    except RuntimeError as exc:
        if str(exc) != '__IMPORT_LIMIT_REACHED__':
            raise
        print(f'IMPORT_LIMIT reached: {import_limit}', flush=True)

    handler.flush()

    if import_limit > 0:
        print('IMPORT_LIMIT active, deletion of stale buildings skipped.', flush=True)
        deleted = 0
    else:
        cur = conn.execute('''
DELETE FROM building_contours
WHERE NOT EXISTS (
  SELECT 1 FROM temp.sync_present p
  WHERE p.osm_type = building_contours.osm_type
    AND p.osm_id = building_contours.osm_id
);
''')
        deleted = cur.rowcount if cur.rowcount is not None else 0

    conn.execute('DROP TABLE IF EXISTS temp.sync_present;')
    conn.commit()

    row = conn.execute('SELECT COUNT(*) AS total, MAX(updated_at) AS last_updated FROM building_contours').fetchone()
    total = row[0] if row else 0
    last_updated = row[1] if row else None

    print(
        f'Sync done. processed={handler.processed_items}, imported={handler.imported}, '
        f'skipped={handler.skipped}, deleted={deleted}, total_in_db={total}, last_updated={last_updated}',
        flush=True
    )


if __name__ == '__main__':
    main()
