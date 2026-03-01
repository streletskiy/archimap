(function initArchiMapMainFilters() {
  function getFilterRules(filterRowsEl) {
    if (!filterRowsEl) return [];
    return [...filterRowsEl.querySelectorAll('[data-filter-row]')]
      .map((row) => {
        const key = String(row.querySelector('[data-field="key"]')?.value || '').trim();
        const op = String(row.querySelector('[data-field="op"]')?.value || 'contains').trim();
        const value = String(row.querySelector('[data-field="value"]')?.value || '').trim();
        return { key, op, value };
      })
      .filter((rule) => rule.key);
  }

  function matchesRule(tags, rule, normalizeTagValue) {
    if (!rule || !rule.key) return true;
    const rawValue = tags?.[rule.key];
    const actual = normalizeTagValue(rawValue);
    const expected = String(rule.value || '');
    const hasValue = actual != null && String(actual).trim().length > 0;
    if (rule.op === 'exists') return hasValue;
    if (rule.op === 'not_exists') return !hasValue;
    if (actual == null) return false;
    const left = String(actual).toLowerCase();
    const right = expected.toLowerCase();
    if (rule.op === 'equals') return left === right;
    if (rule.op === 'not_equals') return left !== right;
    if (rule.op === 'starts_with') return left.startsWith(right);
    return left.includes(right);
  }

  window.ArchiMapMainFilters = {
    getFilterRules,
    matchesRule
  };
})();
