(function initArchiMapUI() {
  function sunIcon() {
    return '<svg class="theme-track-icon-sun h-[14px] w-[14px] fill-current text-slate-700" viewBox="0 0 640 640"><path d="M320 32C328.4 32 336.3 36.4 340.6 43.7L396.1 136.3L500.9 110C509.1 108 517.8 110.4 523.7 116.3C529.6 122.2 532 131 530 139.1L503.7 243.8L596.4 299.3C603.6 303.6 608.1 311.5 608.1 319.9C608.1 328.3 603.7 336.2 596.4 340.5L503.7 396.1L530 500.8C532 509 529.6 517.7 523.7 523.6C517.8 529.5 509 532 500.9 530L396.2 503.7L340.7 596.4C336.4 603.6 328.5 608.1 320.1 608.1C311.7 608.1 303.8 603.7 299.5 596.4L243.9 503.7L139.2 530C131 532 122.4 529.6 116.4 523.7C110.4 517.8 108 509 110 500.8L136.2 396.1L43.6 340.6C36.4 336.2 32 328.4 32 320C32 311.6 36.4 303.7 43.7 299.4L136.3 243.9L110 139.1C108 130.9 110.3 122.3 116.3 116.3C122.3 110.3 131 108 139.2 110L243.9 136.2L299.4 43.6L301.2 41C305.7 35.3 312.6 31.9 320 31.9zM320 176C240.5 176 176 240.5 176 320C176 399.5 240.5 464 320 464C399.5 464 464 399.5 464 320C464 240.5 399.5 176 320 176zM320 416C267 416 224 373 224 320C224 267 267 224 320 224C373 224 416 267 416 320C416 373 373 416 320 416z"></path></svg>';
  }

  function moonIcon() {
    return '<svg class="theme-track-icon-moon h-[14px] w-[14px] fill-current text-slate-700" viewBox="0 0 640 640"><path d="M320 64C178.6 64 64 178.6 64 320C64 461.4 178.6 576 320 576C388.8 576 451.3 548.8 497.3 504.6C504.6 497.6 506.7 486.7 502.6 477.5C498.5 468.3 488.9 462.6 478.8 463.4C473.9 463.8 469 464 464 464C362.4 464 280 381.6 280 280C280 207.9 321.5 145.4 382.1 115.2C391.2 110.7 396.4 100.9 395.2 90.8C394 80.7 386.6 72.5 376.7 70.3C358.4 66.2 339.4 64 320 64z"></path></svg>';
  }

  function labelsIcon() {
    return '<svg viewBox="0 0 640 640" width="12" height="12" class="fill-current text-slate-700" aria-hidden="true"><path d="M73 39.1C63.6 29.7 48.4 29.7 39.1 39.1C29.8 48.5 29.7 63.7 39 73.1L567 601.1C576.4 610.5 591.6 610.5 600.9 601.1C610.2 591.7 610.3 576.5 600.9 567.2L354.7 320.9L400.2 160L503 160L497 184.2C492.7 201.3 503.1 218.7 520.3 223C537.5 227.3 554.8 216.9 559.1 199.7L570.1 155.6C577.6 125.3 554.7 96 523.5 96L204.5 96C184.7 96 167.2 108.1 160 126.1L73 39.1zM212.4 178.5L217 160L333.7 160L302.9 269L212.4 178.5zM273 374.8L243.3 480L192 480C174.3 480 160 494.3 160 512C160 529.7 174.3 544 192 544L352 544C369.7 544 384 529.7 384 512C384 494.3 369.7 480 352 480L309.8 480L324.9 426.7L273 374.8z"></path></svg>';
  }

  function renderToggle(options) {
    var id = options.id;
    var ariaLabel = options.ariaLabel || 'toggle';
    var checkedColorClass = options.checkedColorClass || 'peer-checked:bg-indigo-500';
    var checkedKnobClass = options.checkedKnobClass || '';
    var checkedIconClass = options.checkedIconClass || '';
    var withIcons = Boolean(options.withIcons);
    var kind = options.kind || 'default';
    var wrapperClass = options.wrapperClass || 'relative inline-flex h-10 w-[76px] cursor-pointer items-center rounded-full bg-white/95 shadow-soft hover:bg-slate-50';

    var startIcon = '';
    var endIcon = '';
    var knobIcon = '';

    if (withIcons && kind === 'theme') {
      startIcon = '<span class="pointer-events-none absolute left-1.5 z-[3] inline-flex h-7 w-7 items-center justify-center transition ' + checkedIconClass + '" aria-hidden="true">' + sunIcon() + '</span>';
      endIcon = '<span class="pointer-events-none absolute right-1.5 z-[3] inline-flex h-7 w-7 items-center justify-center transition ' + checkedIconClass + '" aria-hidden="true">' + moonIcon() + '</span>';
    }

    if (withIcons && kind === 'labels') {
      knobIcon = '<span class="pointer-events-none absolute left-1.5 z-[3] inline-flex h-7 w-7 items-center justify-center transition peer-checked:translate-x-[36px] ' + checkedIconClass + '" aria-hidden="true">' + labelsIcon() + '</span>';
    }

    return '<label for="' + id + '" class="' + wrapperClass + '">' +
      '<input id="' + id + '" type="checkbox" class="peer sr-only" aria-label="' + ariaLabel + '" />' +
      '<span class="absolute inset-1 rounded-full bg-slate-300 transition ' + checkedColorClass + '"></span>' +
      startIcon + endIcon + knobIcon +
      '<span class="pointer-events-none absolute left-1.5 z-[2] inline-flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-sm transition peer-checked:translate-x-[36px] ' + checkedKnobClass + '"></span>' +
      '</label>';
  }

  function badge(text, variant) {
    var map = {
      neutral: 'bg-slate-100 text-slate-700',
      success: 'bg-emerald-100 text-emerald-700',
      info: 'bg-blue-100 text-blue-700',
      brand: 'bg-brand-purple/10 text-brand-purple',
      warning: 'bg-amber-100 text-amber-700',
      danger: 'bg-rose-100 text-rose-700'
    };
    var cls = map[variant] || map.neutral;
    return '<span class="rounded-full px-2.5 py-1 text-xs font-medium ' + cls + '">' + String(text || '') + '</span>';
  }

  function panel(content, options) {
    var cls = (options && options.className) || 'rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-soft backdrop-blur-sm';
    return '<section class="' + cls + '">' + String(content || '') + '</section>';
  }

  function sectionHeader(title, subtitle) {
    return '<div class="border-b border-slate-200 pb-4"><h1 class="text-2xl font-extrabold">' + String(title || '') + '</h1><p class="mt-1 text-sm text-slate-600">' + String(subtitle || '') + '</p></div>';
  }

  function tabButtonClass(active) {
    var base = 'ui-tab-btn';
    return active
      ? base + ' ui-tab-btn-active'
      : base;
  }

  function fieldClass(kind, size) {
    var base = 'ui-field';
    var sizeClass = size === 'xs' ? ' ui-field-xs' : '';
    if (kind === 'textarea') return base + sizeClass + ' min-h-[120px]';
    if (kind === 'select') return base + sizeClass;
    return base;
  }

  function buttonClass(variant, size) {
    var map = {
      primary: 'ui-btn ui-btn-primary',
      outlineBrand: 'ui-btn ui-btn-outline-brand',
      secondary: 'ui-btn ui-btn-secondary',
      danger: 'ui-btn ui-btn-danger'
    };
    var sizeClass = '';
    if (size === 'xs') sizeClass = ' ui-btn-xs';
    if (size === 'squareSm') sizeClass = ' ui-btn-square-sm';
    return (map[variant] || map.secondary) + sizeClass;
  }

  function editDetailPane() {
    var dict = window.__ARCHIMAP_I18N_RU && window.__ARCHIMAP_I18N_RU.ui
      ? window.__ARCHIMAP_I18N_RU.ui
      : null;
    var title = dict && Object.prototype.hasOwnProperty.call(dict, 'editDetailTitle')
      ? String(dict.editDetailTitle || 'Правка здания')
      : 'Правка здания';
    var loading = dict && Object.prototype.hasOwnProperty.call(dict, 'adminLoading')
      ? String(dict.adminLoading || 'Загрузка...')
      : 'Загрузка...';
    var diffHint = dict && Object.prototype.hasOwnProperty.call(dict, 'editDetailDiffHint')
      ? String(dict.editDetailDiffHint || 'Diff: было -&gt; стало')
      : 'Diff: было -&gt; стало';

    return '' +
      '<div id="edit-detail-pane" class="pointer-events-none fixed inset-y-0 right-0 z-[1150] hidden px-3 pb-5 pt-[5.5rem] sm:px-4 sm:pb-6 sm:pt-[5.25rem]">' +
      '  <aside class="pointer-events-auto h-full w-[calc(100vw-1.5rem)] rounded-2xl border border-slate-200 bg-white shadow-soft sm:w-[460px] lg:w-[min(36vw,520px)] lg:min-w-[380px]">' +
      '    <div class="flex h-full flex-col">' +
      '      <div class="flex items-start justify-between border-b border-slate-200 px-5 py-4">' +
      '        <div>' +
      '          <h3 id="edit-detail-title" class="text-lg font-bold text-slate-900">' + title + '</h3>' +
      '          <p id="edit-detail-meta" class="mt-1 text-sm text-slate-600">' + loading + '</p>' +
      '        </div>' +
      '        <button id="edit-detail-close" type="button" class="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-100">✕</button>' +
      '      </div>' +
      '      <div class="flex-1 overflow-y-auto px-5 py-4">' +
      '        <p class="mb-3 text-xs uppercase tracking-wide text-slate-400">' + diffHint + '</p>' +
      '        <div id="edit-detail-list" class="space-y-2"></div>' +
      '      </div>' +
      '    </div>' +
      '  </aside>' +
      '</div>';
  }

  window.ArchiMapUI = {
    renderToggle: renderToggle,
    badge: badge,
    panel: panel,
    sectionHeader: sectionHeader,
    tabButtonClass: tabButtonClass,
    fieldClass: fieldClass,
    buttonClass: buttonClass,
    editDetailPane: editDetailPane
  };
})();
