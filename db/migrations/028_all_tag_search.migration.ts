function up(db) {
  db.exec('DROP TABLE IF EXISTS building_search_fts;');
  db.exec(`CREATE VIRTUAL TABLE building_search_fts USING fts5(
    osm_key UNINDEXED, name, address, style, architect, design_ref, tags_text,
    tokenize = 'unicode61 remove_diacritics 2'
  );`);
}
module.exports = { up };
