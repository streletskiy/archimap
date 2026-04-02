export type InitialFilterReplayAction = 'none' | 'refresh' | 'reapply';

export function resolveInitialFilterReplayAction({
  hasFilters = false,
  phase = 'idle',
  paintCalls = 0
}: {
  hasFilters?: boolean;
  phase?: string | null | undefined;
  paintCalls?: number | null | undefined;
} = {}): InitialFilterReplayAction {
  void paintCalls;
  if (!hasFilters) return 'none';
  return String(phase || 'idle') === 'idle' ? 'refresh' : 'reapply';
}
