DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'building_search_source'
      AND column_name = 'design_ref'
  ) THEN
    ALTER TABLE public.building_search_source
      ADD COLUMN design_ref TEXT;

    DROP INDEX IF EXISTS public.idx_building_search_source_tsv;

    ALTER TABLE public.building_search_source
      DROP COLUMN IF EXISTS search_tsv;

    ALTER TABLE public.building_search_source
      ADD COLUMN search_tsv tsvector
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
  END IF;
END $$;
