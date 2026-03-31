export function hasPositiveStyleFilterMatch(filter, key, expectedValue) {
  if (!Array.isArray(filter) || filter.length < 3) return false;

  const operator = String(filter[0] || '').trim().toLowerCase();
  if (operator === 'all' || operator === 'any') {
    return filter.slice(1).some((entry) => hasPositiveStyleFilterMatch(entry, key, expectedValue));
  }

  const filterKey = String(filter[1] || '').trim().toLowerCase();
  if (filterKey !== String(key || '').trim().toLowerCase()) {
    return false;
  }

  if (operator === '==' || operator === 'in') {
    return filter
      .slice(2)
      .some((value) => String(value || '').trim().toLowerCase() === String(expectedValue || '').trim().toLowerCase());
  }

  return false;
}
