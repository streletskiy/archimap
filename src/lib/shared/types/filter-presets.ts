export type FilterPresetRuleOperator = string;

export type FilterPresetLayerMode = 'and' | 'or' | 'layer';

export interface FilterPresetRule {
  id?: string;
  key: string;
  op: FilterPresetRuleOperator;
  value: string;
}

export interface FilterPresetLayer {
  id: string;
  color: string;
  priority: number;
  mode: FilterPresetLayerMode;
  rules: FilterPresetRule[];
}

export type FilterPresetNameI18n = Record<string, string>;

export interface FilterPreset {
  id: number | null;
  key: string;
  name: string;
  nameI18n: FilterPresetNameI18n;
  description: string | null;
  layers: FilterPresetLayer[];
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FilterPresetDraft extends Omit<FilterPreset, 'description'> {
  description: string;
}

export interface FilterPresetInput {
  id?: number | string | null;
  key?: string;
  name?: string;
  nameI18n?: FilterPresetNameI18n | null;
  description?: string | null;
  layers?: FilterPresetLayer[] | null;
}

export interface FilterPresetState {
  source: string;
  items: FilterPreset[];
}
