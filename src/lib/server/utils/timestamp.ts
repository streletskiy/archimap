function toIsoTimestampOrNull(value: unknown): string | null {
  if (value == null) return null;

  const parseTimestamp = (raw: unknown): Date | null => {
    if (raw instanceof Date) {
      return Number.isFinite(raw.getTime()) ? raw : null;
    }

    if (typeof raw === 'number') {
      const date = new Date(raw);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    const text = String(raw || '').trim();
    if (!text) return null;

    const sqlLike = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
    if (sqlLike) {
      const [, datePart, timePart, fractionalPart] = sqlLike;
      const suffix = fractionalPart ? `.${fractionalPart}` : '';
      const date = new Date(`${datePart}T${timePart}${suffix}Z`);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : null;
  };

  const parsed = parseTimestamp(value);
  if (!parsed) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
  toIsoTimestampOrNull
};
