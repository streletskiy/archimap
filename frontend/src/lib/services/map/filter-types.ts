export type BboxSnapshot = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type CoverageWindowSnapshot = BboxSnapshot & {
  marginRatio?: number;
};

export type MoveVector = {
  dx: number;
  dy: number;
};

export type LayerIdsSnapshot = {
  buildingFillLayerIds: string[];
  buildingExtrusionLayerIds: string[];
  buildingLineLayerIds: string[];
  buildingPartFillLayerIds: string[];
  buildingPartExtrusionLayerIds: string[];
  buildingPartLineLayerIds: string[];
  filterHighlightExtrusionLayerIds: string[];
  filterHighlightFillLayerIds: string[];
  filterHighlightLineLayerIds: string[];
  buildingPartFilterHighlightExtrusionLayerIds: string[];
  buildingPartFilterHighlightFillLayerIds: string[];
  buildingPartFilterHighlightLineLayerIds: string[];
  hoverExtrusionLayerIds: string[];
  hoverFillLayerIds: string[];
  hoverLineLayerIds: string[];
  selectedExtrusionLayerIds: string[];
  selectedFillLayerIds: string[];
  selectedLineLayerIds: string[];
};

export type FilterMatchedPoint = {
  id: number;
  lon: number;
  lat: number;
  count?: number;
  osmKey?: string;
};

export type FeatureIdentitySource = {
  id?: number | string | null;
  properties?: {
    osm_key?: string | null;
    osm_type?: string | null;
    osm_id?: number | string | null;
  } | null;
  geometry?: {
    type?: string | null;
  } | null;
} | null | undefined;

export type FilterRuleInput = Record<string, unknown> & {
  key?: unknown;
  op?: unknown;
  value?: unknown;
  numericValue?: unknown;
};

export type FilterRule = {
  key: string;
  op: string;
  value: string;
  valueNormalized: string;
  numericValue: number | null;
};

export type FilterLayerMode = 'and' | 'or' | 'layer';

export type FilterLayerInput = Record<string, unknown> & {
  id?: unknown;
  color?: unknown;
  priority?: unknown;
  mode?: unknown;
  rules?: FilterRuleInput[] | null;
};

export type FilterLayer = {
  id: string;
  color: string;
  priority: number;
  mode: FilterLayerMode;
  rules: FilterRule[];
  originalIndex?: number;
};

export type FilterFeatureState = {
  isFiltered: boolean;
  filterColor: string;
};

export type FilterFeatureStateEntry = {
  id: number;
  state: FilterFeatureState;
};

export type FilterColorGroup = {
  color: string;
  ids: number[];
  points?: FilterMatchedPoint[];
};

export type FilterWorkerPrepareRequest = {
  type: 'prepare-rules';
  requestId: string;
  layers?: FilterLayerInput[] | null;
  rules?: FilterRuleInput[] | null;
};

export type FilterWorkerPrepareResponse =
  | {
    type: 'prepare-rules-result';
    requestId: string;
    ok: true;
    layers?: FilterLayer[];
    rules?: FilterRule[];
    rulesHash: string;
    heavy: boolean;
    layerResults?: Array<{
      id: string;
      ok: true;
      rules: FilterRule[];
      heavy: boolean;
    }>;
  }
  | {
    type: 'prepare-rules-result';
    requestId: string;
    ok: false;
    invalidReason: string;
  };

export type FilterWorkerBuildRequestPlanRequest = {
  type: 'build-request-plan';
  requestId: string;
  layers?: FilterLayerInput[] | null;
  rules?: FilterRuleInput[] | null;
};

export type FilterWorkerBuildRequestPlanResponse =
  | {
    type: 'build-request-plan-result';
    requestId: string;
    ok: true;
    layers: FilterLayer[];
    requestSpecs: FilterRequestSpec[];
    combinedGroup: FilterPreparedGroup | null;
    hasStandaloneLayers: boolean;
    rulesHash: string;
    heavy: boolean;
  }
  | {
    type: 'build-request-plan-result';
    requestId: string;
    ok: false;
    invalidReason: string;
  };

export type FilterWorkerResolvedPayloadInputItem = {
  requestId: string;
  payload: Pick<FilterMatchPayload, 'matchedKeys' | 'matchedFeatureIds' | 'matchedLocations' | 'matchedCount' | 'meta'> | null;
};

export type FilterWorkerBuildResolvedPayloadRequest = {
  type: 'build-resolved-payload';
  requestId: string;
  prepared: FilterPreparedRequest | FilterPreparedRequestPlan;
  payloads: FilterWorkerResolvedPayloadInputItem[];
  cacheHit?: boolean;
};

export type FilterWorkerBuildResolvedPayloadResponse =
  | {
    type: 'build-resolved-payload-result';
    requestId: string;
    ok: true;
    highlightColorGroups: FilterColorGroup[];
    matchedFeatureIds: number[];
    matchedCount: number;
    meta: FilterMatchMeta;
  }
  | {
    type: 'build-resolved-payload-result';
    requestId: string;
    ok: false;
    error: string;
  };

export type FilterWorkerRequest =
  | FilterWorkerPrepareRequest
  | FilterWorkerBuildRequestPlanRequest
  | FilterWorkerBuildResolvedPayloadRequest;

export type FilterWorkerResponse =
  | FilterWorkerPrepareResponse
  | FilterWorkerBuildRequestPlanResponse
  | FilterWorkerBuildResolvedPayloadResponse;

export type FilterWorkerFactory = () => Worker;

export type FilterBuildingSourceConfig = {
  sourceId?: string;
  sourceLayer?: string;
};

export type FilterMapSourceLike = {
  getClusterExpansionZoom?: (
    clusterId: number,
    callback: (error: unknown, zoom?: number) => void
  ) => void;
  setData?: (data: unknown) => void;
  [key: string]: unknown;
} | null | undefined;

export type FilterMapLike = {
  getLayer?: (layerId: string) => unknown;
  setFilter?: (layerId: string, filter: unknown) => void;
  setLayoutProperty?: (layerId: string, property: string, value: unknown) => void;
  setPaintProperty?: (layerId: string, property: string, value: unknown) => void;
  addSource?: (sourceId: string, source: Record<string, unknown>) => void;
  removeSource?: (sourceId: string) => void;
  addLayer?: (layer: Record<string, unknown>, beforeId?: string) => void;
  removeLayer?: (layerId: string) => void;
  moveLayer?: (layerId: string, beforeId?: string) => void;
  getBounds?: () => unknown;
  getZoom?: () => number;
  getCenter?: () => { lng?: number; lat?: number } | null;
  queryRenderedFeatures?: (...args: unknown[]) => unknown[];
  getSource?: (sourceId: string) => FilterMapSourceLike;
  querySourceFeatures?: (sourceId: string, options: { sourceLayer?: string }) => unknown[];
  once?: (event: string, callback: () => void) => void;
  easeTo?: (options: unknown) => void;
  isStyleLoaded?: () => boolean;
  getCanvas?: () => {
    style: { cursor: string };
    toDataURL?: (type: string) => string;
  } | null;
  addControl?: (control: unknown, position?: string) => void;
  remove?: () => void;
  setStyle?: (style: unknown) => void;
  on?: (event: string, callback: (...args: any[]) => void) => void;
};

export type FilterMapDebug = {
  getState?: () => { active?: boolean; exprHash?: string } | null;
  log?: (eventName: string, payload?: Record<string, unknown>) => void;
  updateHook?: (input: FilterDebugHookInput) => { active?: boolean; exprHash?: string } | null;
  recordFilterRequestEvent?: (eventName: string) => void;
  recordFilterTelemetry?: (eventName: string, payload?: Record<string, unknown>) => void;
  clear?: () => void;
};

export type FilterDebugHookInput = {
  active?: boolean;
  expr?: unknown;
  mode?: string;
  phase?: string;
  lastElapsedMs?: number;
  lastCount?: number;
  cacheHit?: boolean;
  setPaintPropertyCalls?: number;
};

export type FilterPipelineState = {
  errorMessage: string;
  statusMessage: string;
  statusCode: string;
  phase: string;
  lastElapsedMs: number;
  lastCount: number;
  lastCacheHit: boolean;
  setPaintPropertyCallsLast: number;
  lastPaintApplyMs: number;
  debugActive: boolean;
  debugExprHash: string;
};

export type FilterRuntimeStatus = {
  phase?: string;
  statusCode?: string;
  message?: string;
  count?: number;
  elapsedMs?: number;
  cacheHit?: boolean;
  setPaintPropertyCalls?: number;
  updatedAt?: number;
};

export type FilterDiffApplyMeta = {
  token?: number;
  phase?: string;
  renderMode?: 'contours' | 'markers';
  forceReapply?: boolean;
  matchedCount?: number;
  matchedFeatureIds?: number[];
  featureIds?: number[];
  layerIds?: LayerIdsSnapshot;
  buildingPartsVisible?: boolean;
  previousActive?: boolean;
  forceStaticPaintProperties?: boolean;
};

export type FilterPreparedGroup = {
  id: string;
  color: string;
  priority: number;
  hasAnd: boolean;
  hasOr: boolean;
};

export type FilterRequestSpec = {
  id: string;
  kind: 'combined-and' | 'combined-or' | 'layer';
  groupId: string;
  layerId?: string;
  rules: FilterRule[];
  rulesHash: string;
  color: string;
  priority: number;
};

export type FilterPreparedRequest = {
  layers: FilterLayer[];
  combinedGroup: FilterPreparedGroup | null;
  requestSpecs: FilterRequestSpec[];
  hasStandaloneLayers: boolean;
};

export type FilterPreparedRequestPlan = FilterPreparedRequest & {
  rulesHash: string;
  heavy: boolean;
};

export type FilterMatchMeta = {
  rulesHash: string;
  bboxHash: string;
  truncated: boolean;
  elapsedMs: number;
  cacheHit: boolean;
  fallback?: boolean;
  renderMode?: 'contours' | 'markers';
  coverageHash?: string;
  coverageWindow?: CoverageWindowSnapshot | null;
  zoomBucket?: number;
  dataVersion?: number;
};

export type FilterMatchPayload = {
  matchedKeys: string[];
  matchedFeatureIds: number[];
  matchedLocations?: FilterMatchedPoint[];
  meta: FilterMatchMeta;
  highlightColorGroups?: FilterColorGroup[];
  matchedCount?: number;
};

export type FilterRequestResolution = {
  spec: FilterRequestSpec;
  payload: FilterMatchPayload;
  cacheHit: boolean;
  usedFallback: boolean;
};

export type FilterResolvedLayerPayload = {
  highlightColorGroups: FilterColorGroup[];
  matchedFeatureIds: number[];
  matchedCount: number;
  meta: FilterMatchMeta;
};

export type FilterCoverageWindow = CoverageWindowSnapshot & {
  rulesHash: string;
  zoomBucket: number;
};

export type FilterCoverageContext = {
  coverageHash: string;
  coverageWindow: CoverageWindowSnapshot;
  rulesHash: string;
  zoomBucket: number;
  renderMode?: 'contours' | 'markers';
  matchLimit?: number;
  bboxHash: string;
  requestSpecs: FilterRequestSpec[];
  heavy?: boolean;
  cacheKey?: string;
  reason?: string;
  combinedGroup?: FilterPreparedGroup | null;
  layers?: FilterLayer[];
  dataVersion?: number;
};
