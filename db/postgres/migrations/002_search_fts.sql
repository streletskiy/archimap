CREATE TABLE IF NOT EXISTS public.building_search_fts (
  osm_key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  architect TEXT NOT NULL DEFAULT '',
  design_ref TEXT NOT NULL DEFAULT ''
);

ALTER TABLE public.building_search_fts
  ALTER COLUMN name SET DEFAULT '',
  ALTER COLUMN address SET DEFAULT '',
  ALTER COLUMN style SET DEFAULT '',
  ALTER COLUMN architect SET DEFAULT '';

ALTER TABLE public.building_search_fts
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN address SET NOT NULL,
  ALTER COLUMN style SET NOT NULL,
  ALTER COLUMN architect SET NOT NULL,
  ALTER COLUMN design_ref SET NOT NULL;

ALTER TABLE public.building_search_fts
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' ||
      coalesce(address, '') || ' ' ||
      coalesce(style, '') || ' ' ||
      coalesce(architect, '') || ' ' ||
      coalesce(design_ref, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_building_search_fts_tsv
  ON public.building_search_fts
  USING GIN (search_tsv);
