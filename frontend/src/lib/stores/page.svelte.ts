import { page as pageState } from '$app/state';
import { toStore } from 'svelte/store';

// Create during component initialization so SSR reads the current request's page.
// Reading each field lets legacy store consumers observe SvelteKit's rune state.
export function createPageStore() {
  return toStore(() => ({
    data: pageState.data,
    error: pageState.error,
    form: pageState.form,
    params: pageState.params,
    route: pageState.route,
    state: pageState.state,
    status: pageState.status,
    url: pageState.url
  }));
}
