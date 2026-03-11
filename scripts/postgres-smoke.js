#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const { Client } = require('pg');
const { getPostgresConnectionString } = require('./lib/postgres-config');

async function run() {
  const connectionString = getPostgresConnectionString(process.env);
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL smoke checks');
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const postgisVersion = await client.query('SELECT postgis_full_version() AS version');
    if (!postgisVersion.rows[0]?.version) {
      throw new Error('PostGIS extension is not available');
    }

    const tables = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE (table_schema, table_name) IN (
        ('osm', 'building_contours'),
        ('local', 'architectural_info'),
        ('user_edits', 'building_user_edits'),
        ('auth', 'users')
      )
    `);
    if (tables.rowCount !== 4) {
      throw new Error('Required PostgreSQL schemas/tables are missing');
    }

    await client.query('BEGIN');
    try {
      await client.query(`
        INSERT INTO osm.building_contours (
          osm_type, osm_id, tags_json, min_lon, min_lat, max_lon, max_lat, geom
        )
        VALUES (
          'way',
          9000000001,
          '{"name":"smoke polygon"}',
          44.0,
          56.0,
          44.001,
          56.001,
          ST_Multi(ST_SetSRID(
            ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[44.0,56.0],[44.001,56.0],[44.001,56.001],[44.0,56.001],[44.0,56.0]]]}'),
            4326
          ))
        )
        ON CONFLICT (osm_type, osm_id) DO UPDATE
        SET
          tags_json = excluded.tags_json,
          min_lon = excluded.min_lon,
          min_lat = excluded.min_lat,
          max_lon = excluded.max_lon,
          max_lat = excluded.max_lat,
          geom = excluded.geom
      `);
      const geo = await client.query(`
        SELECT
          ST_Intersects(
            geom,
            ST_SetSRID(ST_MakeEnvelope(43.99, 55.99, 44.01, 56.01), 4326)
          ) AS intersects_bbox,
          ST_DWithin(
            ST_Centroid(geom)::geography,
            ST_SetSRID(ST_MakePoint(44.0005, 56.0005), 4326)::geography,
            200
          ) AS is_within_200m
        FROM osm.building_contours
        WHERE osm_type = 'way' AND osm_id = 9000000001
      `);

      if (!geo.rows[0]?.intersects_bbox || !geo.rows[0]?.is_within_200m) {
        throw new Error('PostGIS spatial checks failed');
      }
    } finally {
      await client.query('ROLLBACK');
    }

    console.log('PostgreSQL/PostGIS smoke checks passed');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(`[postgres-smoke] ${String(error?.message || error)}`);
  process.exit(1);
});
