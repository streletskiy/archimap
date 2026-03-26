CREATE TABLE public.building_search_source_compact (
  osm_key TEXT PRIMARY KEY,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  name TEXT,
  address TEXT,
  style TEXT,
  architect TEXT,
  design_ref TEXT,
  local_priority INTEGER NOT NULL DEFAULT 0,
  center_lon DOUBLE PRECISION NOT NULL,
  center_lat DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'simple',
        coalesce(name, '') || ' ' ||
        coalesce(address, '') || ' ' ||
        coalesce(style, '') || ' ' ||
        coalesce(architect, '') || ' ' ||
        coalesce(design_ref, '')
      )
    ) STORED,
  CONSTRAINT building_search_source_compact_searchable CHECK (
    NULLIF(btrim(coalesce(name, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(address, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(style, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(architect, '')), '') IS NOT NULL
    OR NULLIF(btrim(coalesce(design_ref, '')), '') IS NOT NULL
  )
);

INSERT INTO public.building_search_source_compact (
  osm_key,
  osm_type,
  osm_id,
  name,
  address,
  style,
  architect,
  design_ref,
  local_priority,
  center_lon,
  center_lat,
  updated_at
)
SELECT
  osm_key,
  osm_type,
  osm_id,
  NULLIF(btrim(name), '') AS name,
  NULLIF(btrim(address), '') AS address,
  NULLIF(btrim(style), '') AS style,
  NULLIF(btrim(architect), '') AS architect,
  NULLIF(btrim(design_ref), '') AS design_ref,
  local_priority,
  center_lon,
  center_lat,
  updated_at
FROM public.building_search_source
WHERE NULLIF(btrim(coalesce(name, '')), '') IS NOT NULL
   OR NULLIF(btrim(coalesce(address, '')), '') IS NOT NULL
   OR NULLIF(btrim(coalesce(style, '')), '') IS NOT NULL
   OR NULLIF(btrim(coalesce(architect, '')), '') IS NOT NULL
   OR NULLIF(btrim(coalesce(design_ref, '')), '') IS NOT NULL;

CREATE INDEX idx_building_search_source_osm_compact
  ON public.building_search_source_compact (osm_type, osm_id);

CREATE INDEX idx_building_search_source_tsv_compact
  ON public.building_search_source_compact
  USING GIN (search_tsv);

DROP TABLE IF EXISTS public.building_search_fts;
DROP TABLE public.building_search_source;

ALTER TABLE public.building_search_source_compact RENAME TO building_search_source;
ALTER TABLE public.building_search_source
  RENAME CONSTRAINT building_search_source_compact_pkey TO building_search_source_pkey;
ALTER TABLE public.building_search_source
  RENAME CONSTRAINT building_search_source_compact_searchable TO building_search_source_searchable;
ALTER INDEX public.idx_building_search_source_osm_compact RENAME TO idx_building_search_source_osm;
ALTER INDEX public.idx_building_search_source_tsv_compact RENAME TO idx_building_search_source_tsv;

ANALYZE public.building_search_source;
