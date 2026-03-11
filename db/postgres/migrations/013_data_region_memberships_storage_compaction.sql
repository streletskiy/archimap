CREATE TABLE public.data_region_memberships_compact (
  region_id BIGINT NOT NULL REFERENCES public.data_sync_regions(id) ON DELETE CASCADE,
  osm_type TEXT NOT NULL,
  osm_id BIGINT NOT NULL,
  PRIMARY KEY (region_id, osm_type, osm_id)
);

INSERT INTO public.data_region_memberships_compact (
  region_id,
  osm_type,
  osm_id
)
SELECT
  region_id,
  osm_type,
  osm_id
FROM public.data_region_memberships;

CREATE INDEX idx_data_region_memberships_feature_compact
  ON public.data_region_memberships_compact (osm_type, osm_id);

DROP TABLE public.data_region_memberships;

ALTER TABLE public.data_region_memberships_compact RENAME TO data_region_memberships;
ALTER TABLE public.data_region_memberships
  RENAME CONSTRAINT data_region_memberships_compact_pkey TO data_region_memberships_pkey;
ALTER INDEX public.idx_data_region_memberships_feature_compact RENAME TO idx_data_region_memberships_feature;

ANALYZE public.data_region_memberships;
