(function initArchiMapAdminEdits() {
  function getChangeCounters(changes) {
    const list = Array.isArray(changes) ? changes : [];
    let created = 0;
    let modified = 0;
    for (const change of list) {
      if (change?.osmValue == null && change?.localValue != null) {
        created += 1;
      } else {
        modified += 1;
      }
    }
    return { total: list.length, created, modified };
  }

  window.ArchiMapAdminEdits = {
    getChangeCounters
  };
})();
