ALTER TABLE public.building_search_source
  DROP CONSTRAINT IF EXISTS building_search_source_searchable;

ALTER TABLE public.building_search_source
  ADD CONSTRAINT building_search_source_searchable CHECK (
    NULLIF(btrim(COALESCE(name, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(address, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(style, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(architect, '')), '') IS NOT NULL
    OR NULLIF(btrim(COALESCE(design_ref, '')), '') IS NOT NULL
  );
