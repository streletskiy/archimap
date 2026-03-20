function createExtractsDomain(context = {}) {
  const {
    ensureBootstrapped,
    normalizeNullableText,
    extractResolver
  } = context;

  function requireExtractResolver() {
    if (
      !extractResolver
      || typeof extractResolver.searchExtractCandidates !== 'function'
      || typeof extractResolver.resolveExactExtract !== 'function'
    ) {
      throw new Error('Extract resolver is not configured');
    }
    return extractResolver;
  }

  function normalizeExtractCandidate(candidate = {}) {
    const extractSource = normalizeNullableText(
      candidate.extractSource ?? candidate.source,
      64
    );
    const extractId = normalizeNullableText(
      candidate.extractId ?? candidate.fileName ?? candidate.id,
      240
    );
    if (!extractSource || !extractId) {
      return null;
    }
    const extractLabel = normalizeNullableText(
      candidate.extractLabel ?? candidate.label ?? candidate.name ?? extractId,
      240
    ) || extractId;
    return {
      extractSource,
      extractId,
      extractLabel,
      downloadUrl: normalizeNullableText(candidate.downloadUrl ?? candidate.url, 1000),
      matchKind: normalizeNullableText(candidate.matchKind, 64),
      exact: candidate.exact === true
    };
  }

  function buildResolutionRequiredMessage(result = {}, query = '') {
    const base = normalizeNullableText(result.message, 1000);
    if (base) return base;
    const searchQuery = normalizeNullableText(query, 240);
    if (result.errorCode === 'multiple') {
      return searchQuery
        ? `Query "${searchQuery}" matches multiple extract candidates. Choose one manually.`
        : 'Query matches multiple extract candidates. Choose one manually.';
    }
    if (result.errorCode === 'not_found') {
      return searchQuery
        ? `No exact canonical extract was found for query "${searchQuery}".`
        : 'Exact canonical extract was not found.';
    }
    return 'Region requires manual canonical extract selection.';
  }

  async function searchExtractCandidates(query, options = {}) {
    await ensureBootstrapped();
    const normalizedQuery = normalizeNullableText(query, 240);
    if (!normalizedQuery) {
      return {
        query: '',
        items: []
      };
    }

    const resolver = requireExtractResolver();
    const result = await resolver.searchExtractCandidates(normalizedQuery, options);
    const items = Array.isArray(result?.items)
      ? result.items.map(normalizeExtractCandidate).filter(Boolean)
      : [];

    return {
      query: normalizedQuery,
      items
    };
  }

  async function validateSelectedExtract(input = {}, previous = null) {
    await ensureBootstrapped();
    const extractSource = normalizeNullableText(
      input.extractSource ?? input.extract_source ?? previous?.extractSource,
      64
    );
    const extractId = normalizeNullableText(
      input.extractId ?? input.extract_id ?? previous?.extractId,
      240
    );
    const providedLabel = normalizeNullableText(
      input.extractLabel ?? input.extract_label ?? previous?.extractLabel,
      240
    );

    if (!extractSource || !extractId) {
      return {
        candidate: null,
        error: 'Select a canonical extract before saving the region.'
      };
    }

    try {
      const result = await requireExtractResolver().resolveExactExtract(extractId, {
        source: extractSource
      });
      const candidate = normalizeExtractCandidate(result?.candidate || {});
      if (!candidate) {
        return {
          candidate: null,
          error: buildResolutionRequiredMessage(result, extractId)
        };
      }
      return {
        candidate: {
          ...candidate,
          extractLabel: candidate.extractLabel || providedLabel || extractId
        },
        error: null
      };
    } catch (error) {
      return {
        candidate: null,
        error: `Failed to validate canonical extract: ${String(error?.message || error || 'Unknown error')}`
      };
    }
  }

  return {
    searchExtractCandidates,
    validateSelectedExtract
  };
}

module.exports = {
  createExtractsDomain
};
