(function initArchiMapMainModal() {
  function splitSemicolonValues(value) {
    return String(value || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function buildCopyChips(items, emptyFallback, escapeHtml) {
    if (!Array.isArray(items) || items.length === 0) return escapeHtml(emptyFallback);
    const chips = items.map((item) => {
      const raw = String(item?.raw ?? '').trim();
      const label = String(item?.label ?? raw).trim();
      if (!raw || !label) return '';
      return `<button type="button" data-copy-chip="true" data-copy-value="${escapeHtml(raw)}" class="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-800 transition hover:bg-slate-200">${escapeHtml(label)}</button>`;
    }).join('');
    return `<div class="flex flex-wrap gap-1.5">${chips}</div>`;
  }

  function buildReadonlyField(label, valueHtml, escapeHtml) {
    return `
      <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
        <div class="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(label)}</div>
        <div class="text-sm leading-5 text-slate-800">${valueHtml}</div>
      </div>
    `;
  }

  window.ArchiMapMainModal = {
    splitSemicolonValues,
    buildCopyChips,
    buildReadonlyField
  };
})();
