(function initArchiMapAdminGuideUiKit() {
  function renderUiEmailCard(title, template, helpers) {
    const escapeHtml = helpers?.escapeHtml || ((v) => String(v ?? ''));
    const t = helpers?.t || ((_, __, fallback) => String(fallback || ''));
    const subject = String(template?.subject || '');
    const html = String(template?.html || '');
    const text = String(template?.text || '');
    return [
      '<article class="rounded-2xl border border-slate-200 bg-white p-3">',
      '<h3 class="text-sm font-semibold text-slate-900">' + escapeHtml(title) + '</h3>',
      '<p class="mt-1 text-xs text-slate-500">' + escapeHtml(t('uiEmailSubject', { value: subject }, 'Subject: {value}')) + '</p>',
      '<div class="mt-3 grid gap-3 xl:grid-cols-2">',
      '<div class="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">',
      '<p class="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">' + escapeHtml(t('uiEmailHtml', 'HTML')) + '</p>',
      '<iframe class="h-[420px] w-full bg-white" sandbox="" referrerpolicy="no-referrer" srcdoc="' + escapeHtml(html) + '"></iframe>',
      '</div>',
      '<div class="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">',
      '<p class="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">' + escapeHtml(t('uiEmailText', 'Text')) + '</p>',
      '<pre class="m-0 h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-slate-700">' + escapeHtml(text) + '</pre>',
      '</div>',
      '</div>',
      '</article>'
    ].join('');
  }

  window.ArchiMapAdminGuideUiKit = {
    renderUiEmailCard
  };
})();
