import { expandBboxWithMargin, getAdaptiveCoverageMarginRatio } from './map-math-utils';
import type {
  BboxSnapshot,
  CoverageWindowSnapshot,
  MoveVector
} from './filter-types.js';

export function buildBboxSnapshot(bounds: {
  getWest?: () => number;
  getSouth?: () => number;
  getEast?: () => number;
  getNorth?: () => number;
} | null | undefined): BboxSnapshot | null {
  const west = Number(bounds?.getWest?.());
  const south = Number(bounds?.getSouth?.());
  const east = Number(bounds?.getEast?.());
  const north = Number(bounds?.getNorth?.());
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

export function buildBboxHash(bbox: BboxSnapshot | null | undefined, precision = 4) {
  if (!bbox) return 'bbox:none';
  return [
    Number(bbox.west).toFixed(precision),
    Number(bbox.south).toFixed(precision),
    Number(bbox.east).toFixed(precision),
    Number(bbox.north).toFixed(precision)
  ].join(':');
}

export function isViewportInsideBbox(
  viewport: BboxSnapshot | null | undefined,
  containerBbox: BboxSnapshot | null | undefined,
  epsilon = 1e-7
) {
  if (!viewport || !containerBbox) return false;
  const viewportWest = Number(viewport.west);
  const viewportSouth = Number(viewport.south);
  const viewportEast = Number(viewport.east);
  const viewportNorth = Number(viewport.north);
  const boxWest = Number(containerBbox.west);
  const boxSouth = Number(containerBbox.south);
  const boxEast = Number(containerBbox.east);
  const boxNorth = Number(containerBbox.north);
  if (![viewportWest, viewportSouth, viewportEast, viewportNorth, boxWest, boxSouth, boxEast, boxNorth].every(Number.isFinite)) {
    return false;
  }
  return (
    viewportWest >= (boxWest - epsilon) &&
    viewportSouth >= (boxSouth - epsilon) &&
    viewportEast <= (boxEast + epsilon) &&
    viewportNorth <= (boxNorth + epsilon)
  );
}

export function getCoverageWindowForViewport(viewportBbox: BboxSnapshot | null | undefined, {
  lastCount = 0,
  defaultLimit,
  minMargin,
  maxMargin
}: {
  lastCount?: number;
  defaultLimit?: number;
  minMargin?: number;
  maxMargin?: number;
} = {}): CoverageWindowSnapshot | null {
  const marginRatio = getAdaptiveCoverageMarginRatio({
    lastCount,
    defaultLimit,
    min: minMargin,
    max: maxMargin
  });
  const windowBbox = expandBboxWithMargin(viewportBbox, marginRatio);
  if (!windowBbox) return null;
  return {
    ...windowBbox,
    marginRatio
  };
}

export function buildPrefetchCoverageWindow(
  coverageWindow: BboxSnapshot | null | undefined,
  moveVector: MoveVector = { dx: 0, dy: 0 }
): BboxSnapshot | null {
  if (!coverageWindow) return null;
  const width = Number(coverageWindow.east) - Number(coverageWindow.west);
  const height = Number(coverageWindow.north) - Number(coverageWindow.south);
  if (!(width > 0) || !(height > 0)) return null;
  const directionX = moveVector.dx > 0 ? 1 : (moveVector.dx < 0 ? -1 : 0);
  const directionY = moveVector.dy > 0 ? 1 : (moveVector.dy < 0 ? -1 : 0);
  const shiftX = width * (directionX === 0 ? 0.7 : 1.02 * directionX);
  const shiftY = height * (directionY === 0 ? 0.7 : 1.02 * directionY);
  return {
    west: Number(coverageWindow.west) + shiftX,
    east: Number(coverageWindow.east) + shiftX,
    south: Number(coverageWindow.south) + shiftY,
    north: Number(coverageWindow.north) + shiftY
  };
}
