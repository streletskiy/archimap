function normalizeUiDateValue(value: unknown) {
  const raw =
    typeof value === 'object' && value && 'toISOString' in value && typeof value.toISOString === 'function'
      ? value.toISOString()
      : (value as { toString?: () => string } | null)?.toString?.() || '';
  const text = String(raw || '').trim();
  return text ? text.slice(0, 10) : '';
}

export function getEditsDateRangeParams(range: { start?: unknown; end?: unknown } | null | undefined) {
  const start = normalizeUiDateValue(range?.start);
  const end = normalizeUiDateValue(range?.end || range?.start);
  return {
    from: start,
    to: end
  };
}
