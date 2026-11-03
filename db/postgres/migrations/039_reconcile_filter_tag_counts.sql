-- Migration 036 populated the dictionary before installing its triggers.
-- Repair any writes that committed in that upgrade window. Keep this source
-- lock until the migration transaction commits so the scan and live deltas
-- cannot overlap; ordinary map reads remain available.
LOCK TABLE osm.building_contours IN SHARE ROW EXCLUSIVE MODE;

TRUNCATE public.filter_tag_key_counts;
INSERT INTO public.filter_tag_key_counts (tag_key, feature_count)
SELECT key, count(*) FROM osm.building_contours bc
CROSS JOIN LATERAL unnest(public.archimap_filter_tag_keys(bc.tags_json)) AS key
GROUP BY key;

DELETE FROM public.filter_tag_keys_cache;
INSERT INTO public.filter_tag_keys_cache (tag_key, updated_at)
SELECT tag_key, NOW() FROM public.filter_tag_key_counts WHERE feature_count > 0;
