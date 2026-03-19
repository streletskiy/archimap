const { sql } = require('drizzle-orm');
const { pgSchema, text, bigint, integer, doublePrecision, timestamp } = require('drizzle-orm/pg-core');
const { sqliteTable, integer: sqliteInteger, text: sqliteText, real: sqliteReal } = require('drizzle-orm/sqlite-core');

const osm = pgSchema('osm');
const local = pgSchema('local');
const userEdits = pgSchema('user_edits');
const auth = pgSchema('auth');

const pgBuildingContours = osm.table('building_contours', {
  osmType: text('osm_type').notNull(),
  osmId: bigint('osm_id', { mode: 'number' }).notNull(),
  tagsJson: text('tags_json'),
  minLon: doublePrecision('min_lon').notNull(),
  minLat: doublePrecision('min_lat').notNull(),
  maxLon: doublePrecision('max_lon').notNull(),
  maxLat: doublePrecision('max_lat').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  geom: sql`geometry(MultiPolygon, 4326)`,
  buildingLevelsNum: doublePrecision('building_levels_num')
}, (table) => ({
  pk: sql`PRIMARY KEY (${table.osmType}, ${table.osmId})`
}));

const pgArchitecturalInfo = local.table('architectural_info', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  osmType: text('osm_type').notNull(),
  osmId: bigint('osm_id', { mode: 'number' }).notNull(),
  name: text('name'),
  style: text('style'),
  material: text('material'),
  colour: text('colour'),
  levels: integer('levels'),
  yearBuilt: integer('year_built'),
  architect: text('architect'),
  address: text('address'),
  description: text('description'),
  archimapDescription: text('archimap_description'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

const pgUsers = auth.table('users', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  canEdit: integer('can_edit').notNull().default(0),
  isAdmin: integer('is_admin').notNull().default(0),
  isMasterAdmin: integer('is_master_admin').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

const sqliteBuildingContours = sqliteTable('building_contours', {
  osmType: sqliteText('osm_type').notNull(),
  osmId: sqliteInteger('osm_id').notNull(),
  tagsJson: sqliteText('tags_json'),
  geometryJson: sqliteText('geometry_json').notNull(),
  minLon: sqliteReal('min_lon').notNull(),
  minLat: sqliteReal('min_lat').notNull(),
  maxLon: sqliteReal('max_lon').notNull(),
  maxLat: sqliteReal('max_lat').notNull(),
  updatedAt: sqliteText('updated_at').notNull()
});

const sqliteArchitecturalInfo = sqliteTable('architectural_info', {
  id: sqliteInteger('id').primaryKey(),
  osmType: sqliteText('osm_type').notNull(),
  osmId: sqliteInteger('osm_id').notNull(),
  name: sqliteText('name'),
  style: sqliteText('style'),
  material: sqliteText('material'),
  colour: sqliteText('colour'),
  levels: sqliteInteger('levels'),
  yearBuilt: sqliteInteger('year_built'),
  architect: sqliteText('architect'),
  address: sqliteText('address'),
  description: sqliteText('description'),
  archimapDescription: sqliteText('archimap_description'),
  updatedBy: sqliteText('updated_by'),
  createdAt: sqliteText('created_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull()
});

const sqliteUsers = sqliteTable('users', {
  id: sqliteInteger('id').primaryKey(),
  email: sqliteText('email').notNull(),
  passwordHash: sqliteText('password_hash').notNull(),
  firstName: sqliteText('first_name'),
  lastName: sqliteText('last_name'),
  canEdit: sqliteInteger('can_edit').notNull(),
  isAdmin: sqliteInteger('is_admin').notNull(),
  isMasterAdmin: sqliteInteger('is_master_admin').notNull(),
  createdAt: sqliteText('created_at').notNull()
});

module.exports = {
  pgBuildingContours,
  pgArchitecturalInfo,
  pgUsers,
  userEdits,
  sqliteBuildingContours,
  sqliteArchitecturalInfo,
  sqliteUsers
};
