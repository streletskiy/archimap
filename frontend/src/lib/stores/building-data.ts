import { writable } from 'svelte/store';

// Client caches must not outlive the user or the edits that produced them.
export const buildingDataRevision = writable(0);

export function invalidateBuildingData() {
  buildingDataRevision.update((revision) => revision + 1);
}
