CREATE INDEX idx_building_data_changes_generation ON public.building_data_changes (generation);

-- Most buildings have no local overrides; parsing their tags does not need the
-- override resolver's field/alias loop.
CREATE FUNCTION public.archimap_parse_tags(raw_tags TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE doc JSONB;
BEGIN
  BEGIN doc := raw_tags::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN '{}'::jsonb; END;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN RETURN '{}'::jsonb; END IF;
  RETURN doc;
END $$;
