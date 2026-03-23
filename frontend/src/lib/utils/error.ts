export function isAbortError(error) {
  return String(error?.name || '').toLowerCase() === 'aborterror';
}
