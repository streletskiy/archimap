-- Contour bounds use DOUBLE PRECISION. PostgreSQL does not implicitly narrow
-- them to REAL when resolving the capture function from transition tables.
DROP FUNCTION osm.region_tile_dirty_input(TEXT, geometry, REAL, REAL, REAL, REAL);

CREATE FUNCTION osm.region_tile_dirty_input(tags_text TEXT, shape geometry,
  min_lon DOUBLE PRECISION, min_lat DOUBLE PRECISION, max_lon DOUBLE PRECISION, max_lat DOUBLE PRECISION)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'west', ST_XMin(shape), 'south', ST_YMin(shape),
    'east', ST_XMax(shape), 'north', ST_YMax(shape),
    'min_lon', min_lon, 'min_lat', min_lat, 'max_lon', max_lon, 'max_lat', max_lat,
    'is_part', POSITION('"building"' IN COALESCE(tags_text, '')) = 0 AND
      (POSITION('"building:part"' IN COALESCE(tags_text, '')) > 0 OR
       POSITION('"building_part"' IN COALESCE(tags_text, '')) > 0));
$$;
