import { writable } from 'svelte/store';

export const buildingModalOpen = writable(false);

export function openBuildingModal() {
  buildingModalOpen.set(true);
}

export function closeBuildingModal() {
  buildingModalOpen.set(false);
}
