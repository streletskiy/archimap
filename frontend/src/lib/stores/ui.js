import { writable } from 'svelte/store';

export const sidebarOpen = writable(true);
export const buildingModalOpen = writable(false);

export function toggleSidebar(forceValue = null) {
  sidebarOpen.update((value) => (typeof forceValue === 'boolean' ? forceValue : !value));
}

export function openBuildingModal() {
  buildingModalOpen.set(true);
}

export function closeBuildingModal() {
  buildingModalOpen.set(false);
}
