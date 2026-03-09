export const FILTER_LAYER_BASE_COLOR = '#f59e0b';

export const FILTER_LAYER_COLOR_PALETTE = Object.freeze([
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#6366f1',
  '#14b8a6',
  '#e11d48'
]);

export const FILTER_PRESETS = Object.freeze([
  {
    id: 'building-levels',
    labelKey: 'header.presets.buildingLevels',
    fallbackLabel: 'Этажность',
    layers: [
      { color: '#86efac', mode: 'layer', rules: [{ key: 'building:levels', op: 'equals', value: '1' }] },
      { color: '#fde047', mode: 'layer', rules: [{ key: 'building:levels', op: 'equals', value: '2' }] },
      {
        color: '#fdba74',
        mode: 'layer',
        rules: [
          { key: 'building:levels', op: 'greater_or_equals', value: '3' },
          { key: 'building:levels', op: 'less_than', value: '5' }
        ]
      },
      {
        color: '#fb923c',
        mode: 'layer',
        rules: [
          { key: 'building:levels', op: 'greater_or_equals', value: '5' },
          { key: 'building:levels', op: 'less_than', value: '9' }
        ]
      },
      {
        color: '#f87171',
        mode: 'layer',
        rules: [
          { key: 'building:levels', op: 'greater_or_equals', value: '9' },
          { key: 'building:levels', op: 'less_than', value: '16' }
        ]
      },
      { color: '#c084fc', mode: 'layer', rules: [{ key: 'building:levels', op: 'greater_or_equals', value: '16' }] }
    ]
  },
  {
    id: 'building-material',
    labelKey: 'header.presets.buildingMaterial',
    fallbackLabel: 'Материал',
    layers: [
      { color: '#fca5a5', mode: 'layer', rules: [{ key: 'building:material', op: 'equals', value: 'brick' }] },
      { color: '#93c5fd', mode: 'layer', rules: [{ key: 'building:material', op: 'equals', value: 'concrete' }] },
      { color: '#86efac', mode: 'layer', rules: [{ key: 'building:material', op: 'equals', value: 'wood' }] },
      { color: '#d8b4fe', mode: 'layer', rules: [{ key: 'building:material', op: 'equals', value: 'panel' }] }
    ]
  }
]);
