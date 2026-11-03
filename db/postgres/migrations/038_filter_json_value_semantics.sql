-- Match the application's String/Array.join semantics without duplicating tag storage.
-- OSM tags are strings; this also preserves legacy/custom JSON values.
CREATE OR REPLACE FUNCTION osm.filter_json_text(value JSONB, array_separator TEXT DEFAULT ';')
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'null' THEN RETURN NULL;
    WHEN 'object' THEN RETURN '[object Object]';
    WHEN 'array' THEN
      SELECT COALESCE(string_agg(COALESCE(osm.filter_json_text(element, ','), ''), array_separator ORDER BY ordinal), '')
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(element, ordinal);
      RETURN result;
    ELSE RETURN value #>> '{}';
  END CASE;
END;
$$;
