const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPostgresRegionExportQuery,
  buildPostgresRegionBaseGeojsonExportQuery,
  buildPostgresRegionGeojsonExportQuery,
  buildPostgresRegionRemainderGeojsonExportQuery
} = require('../../scripts/region-sync/region-db');

test('buildPostgresRegionExportQuery avoids server-side remainder geometry work', () => {
  const sql = buildPostgresRegionExportQuery();

  assert.match(sql, /FROM public\.data_region_memberships drm/i);
  assert.match(sql, /JOIN osm\.building_contours bc/i);
  assert.match(sql, /ST_AsGeoJSON\(bc\.geom\)::text AS geometry_json/i);
  assert.doesNotMatch(sql, /ST_Difference/i);
  assert.doesNotMatch(sql, /building_remainders/i);
  assert.doesNotMatch(sql, /UNION ALL/i);
});

test('buildPostgresRegionBaseGeojsonExportQuery streams base features from the temp part table', () => {
  const sql = buildPostgresRegionBaseGeojsonExportQuery();

  assert.match(sql, /FROM public\.data_region_memberships drm/i);
  assert.match(sql, /JOIN osm\.building_contours bc/i);
  assert.match(sql, /pg_temp\.region_export_parts_tmp/i);
  assert.match(sql, /render_hide_base_when_parts/i);
  assert.doesNotMatch(sql, /WITH region_members AS/i);
  assert.doesNotMatch(sql, /ST_Difference/i);
  assert.doesNotMatch(sql, /UNION ALL/i);
});

test('buildPostgresRegionRemainderGeojsonExportQuery derives building remainders from the temp part table', () => {
  const sql = buildPostgresRegionRemainderGeojsonExportQuery();

  assert.match(sql, /FROM public\.data_region_memberships drm/i);
  assert.match(sql, /JOIN osm\.building_contours bc/i);
  assert.match(sql, /pg_temp\.region_export_parts_tmp/i);
  assert.match(sql, /ST_Difference\(b\.geom, part_union\.geom\)/i);
  assert.match(sql, /building_remainder/i);
  assert.match(sql, /render_hide_base_when_parts/i);
  assert.doesNotMatch(sql, /WITH region_members AS/i);
});

test('buildPostgresRegionGeojsonExportQuery remains a compatibility wrapper for combined export', () => {
  const sql = buildPostgresRegionGeojsonExportQuery();

  assert.match(sql, /pg_temp\.region_export_parts_tmp/i);
  assert.match(sql, /UNION ALL/i);
  assert.match(sql, /ST_Difference\(b\.geom, part_union\.geom\)/i);
  assert.match(sql, /building_remainder/i);
  assert.match(sql, /render_hide_base_when_parts/i);
  assert.doesNotMatch(sql, /WITH region_members AS/i);
});
