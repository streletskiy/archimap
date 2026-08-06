import type { RegionExtractCandidate, RegionExtractSearchResult, RegionExtractValidationResult } from '$shared/types';

function createExtractsDomain(context: LooseRecord = {}) {
  const { ensureBootstrapped, normalizeNullableText, regionCatalog, extractResolver } = context;

  function hasRegionCatalog() {
    return (
      regionCatalog &&
      typeof regionCatalog.findEntry === 'function' &&
      typeof regionCatalog.searchVisibleEntries === 'function'
    );
  }

  function hasExtractResolver() {
    return (
      extractResolver &&
      typeof extractResolver.searchExtractCandidates === 'function' &&
      typeof extractResolver.resolveExactExtract === 'function'
    );
  }

  function normalizeCatalogEntry(entry: LooseRecord = {}): RegionExtractCandidate | null {
    const extractSource = normalizeNullableText(entry.extractSource, 64);
    const extractId = normalizeNullableText(entry.extractId, 240);
    if (!extractSource || !extractId) {
      return null;
    }
    return {
      extractSource,
      extractId,
      extractLabel: normalizeNullableText(entry.name ?? entry.extractLabel ?? extractId, 240) || extractId,
      downloadUrl: normalizeNullableText(entry.downloadUrl, 4000),
      matchKind: 'catalog',
      exact: true
    };
  }

  async function searchExtractCandidates(query, options: LooseRecord = {}): Promise<RegionExtractSearchResult> {
    await ensureBootstrapped();
    const normalizedQuery = normalizeNullableText(query, 240);
    if (!normalizedQuery) {
      return {
        query: '',
        items: []
      };
    }

    let items: RegionExtractCandidate[] = [];
    if (hasRegionCatalog()) {
      items = regionCatalog
        .searchVisibleEntries(normalizedQuery, options)
        .map(normalizeCatalogEntry)
        .filter((item): item is RegionExtractCandidate => Boolean(item));
    } else if (hasExtractResolver()) {
      const result = await extractResolver.searchExtractCandidates(normalizedQuery, options);
      items = (Array.isArray(result?.items) ? result.items : [])
        .map(normalizeCatalogEntry)
        .filter((item): item is RegionExtractCandidate => Boolean(item));
    }

    return {
      query: normalizedQuery,
      items
    };
  }

  async function resolveExactExtractCandidate(query, options: LooseRecord = {}) {
    await ensureBootstrapped();
    const extractSource = normalizeNullableText(options.source, 64);
    const normalizedQuery = normalizeNullableText(query, 240);
    if (!extractSource || !normalizedQuery) {
      return {
        candidate: null,
        errorCode: 'not_found',
        message: 'Exact canonical extract was not found.'
      };
    }

    let candidate = null;
    if (hasRegionCatalog()) {
      candidate = normalizeCatalogEntry(regionCatalog.findEntry(extractSource, normalizedQuery) || {});
    }
    if (!candidate && hasExtractResolver()) {
      const result = await extractResolver.resolveExactExtract(normalizedQuery, {
        source: extractSource
      });
      candidate = normalizeCatalogEntry(result?.candidate || {});
    }
    if (!candidate) {
      return {
        candidate: null,
        errorCode: 'not_found',
        message: 'Exact canonical extract was not found.'
      };
    }

    return {
      candidate,
      errorCode: null,
      message: null
    };
  }

  async function validateSelectedExtract(
    input: LooseRecord = {},
    previous: { extractSource?: string | null; extractId?: string | null; extractLabel?: string | null } | null = null
  ): Promise<RegionExtractValidationResult> {
    await ensureBootstrapped();
    const extractSource = normalizeNullableText(
      input.extractSource ?? input.extract_source ?? previous?.extractSource,
      64
    );
    const extractId = normalizeNullableText(input.extractId ?? input.extract_id ?? previous?.extractId, 240);
    const providedLabel = normalizeNullableText(
      input.extractLabel ?? input.extract_label ?? previous?.extractLabel,
      240
    );

    if (!extractSource || !extractId) {
      return {
        candidate: null,
        error: 'Select a curated extract before saving the region (canonical extract selection is required).'
      };
    }

    let candidate = null;
    if (hasRegionCatalog()) {
      candidate = normalizeCatalogEntry(regionCatalog.findEntry(extractSource, extractId) || {});
    }
    if (!candidate && hasExtractResolver()) {
      const result = await extractResolver.resolveExactExtract(extractId, {
        source: extractSource
      });
      candidate = normalizeCatalogEntry(result?.candidate || {});
    }
    if (!candidate) {
      return {
        candidate: null,
        error: `Curated extract is not available in the local catalog: ${extractSource} ${extractId}`
      };
    }

    return {
      candidate: {
        ...candidate,
        extractLabel: candidate.extractLabel || providedLabel || extractId
      },
      error: null
    };
  }

  return {
    searchExtractCandidates,
    resolveExactExtractCandidate,
    validateSelectedExtract
  };
}

module.exports = {
  createExtractsDomain
};
