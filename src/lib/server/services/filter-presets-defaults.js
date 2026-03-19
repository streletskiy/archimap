const DEFAULT_FILTER_PRESETS = Object.freeze([
  {
    key: 'building-levels',
    name: 'Building levels',
    nameI18n: {
      en: 'Building levels',
      ru: 'Этажность'
    },
    description: '',
    layers: Object.freeze([
      {
        color: '#86efac',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'equals', value: '1' }
        ])
      },
      {
        color: '#fde047',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'equals', value: '2' }
        ])
      },
      {
        color: '#fdba74',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'greater_or_equals', value: '3' },
          { key: 'building:levels', op: 'less_than', value: '5' }
        ])
      },
      {
        color: '#fb923c',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'greater_or_equals', value: '5' },
          { key: 'building:levels', op: 'less_than', value: '9' }
        ])
      },
      {
        color: '#f87171',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'greater_or_equals', value: '9' },
          { key: 'building:levels', op: 'less_than', value: '16' }
        ])
      },
      {
        color: '#c084fc',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:levels', op: 'greater_or_equals', value: '16' }
        ])
      }
    ])
  },
  {
    key: 'building-material',
    name: 'Building material',
    nameI18n: {
      en: 'Building material',
      ru: 'Материал здания'
    },
    description: '',
    layers: Object.freeze([
      {
        color: '#fca5a5',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:material', op: 'equals', value: 'brick' }
        ])
      },
      {
        color: '#93c5fd',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:material', op: 'equals', value: 'concrete' }
        ])
      },
      {
        color: '#86efac',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:material', op: 'equals', value: 'wood' }
        ])
      },
      {
        color: '#d8b4fe',
        mode: 'layer',
        rules: Object.freeze([
          { key: 'building:material', op: 'equals', value: 'panel' }
        ])
      }
    ])
  }
]);

module.exports = {
  DEFAULT_FILTER_PRESETS
};
