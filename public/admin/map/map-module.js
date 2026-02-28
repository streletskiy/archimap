(function initArchiMapAdminMap() {
  function extendBoundsFromCoords(bounds, coords) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      bounds.extend([coords[0], coords[1]]);
      return;
    }
    for (const value of coords) extendBoundsFromCoords(bounds, value);
  }

  function getEditedKeysExpression(keys) {
    const encodedIds = [];
    for (const key of keys || []) {
      const [osmType, osmIdRaw] = String(key).split('/');
      const osmId = Number(osmIdRaw);
      if (!['way', 'relation'].includes(osmType) || !Number.isInteger(osmId) || osmId <= 0) continue;
      const typeBit = osmType === 'relation' ? 1 : 0;
      encodedIds.push((osmId * 2) + typeBit);
    }
    return ['in', ['id'], ['literal', encodedIds]];
  }

  window.ArchiMapAdminMap = {
    extendBoundsFromCoords,
    getEditedKeysExpression
  };
})();
