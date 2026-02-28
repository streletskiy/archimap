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

  function buildModalHtml(ctx) {
    const t = ctx.t;
    const escapeHtml = ctx.escapeHtml;
    const info = ctx.info;

    const editableRows = ctx.canEditBuildings
      ? `
      <form id="building-edit-form" class="grid gap-2">
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-name" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelName', null, 'Название:'))}</label>
          <input id="building-name" name="building-name" type="text" value="${escapeHtml(info.name || (ctx.shownName !== '-' ? ctx.shownName : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-levels" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelLevels', null, 'Этажей:'))}</label>
          <input id="building-levels" name="building-levels" type="number" value="${escapeHtml(info.levels ?? (ctx.shownLevels !== '-' ? ctx.shownLevels : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-year" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelYearBuilt', null, 'Год постройки:'))}</label>
          <input id="building-year" name="building-year" type="number" value="${escapeHtml(info.year_built || (ctx.shownYear !== '-' ? ctx.shownYear : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-architect" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelArchitect', null, 'Архитектор:'))}</label>
          <input id="building-architect" name="building-architect" type="text" value="${escapeHtml(info.architect || (ctx.shownArchitect !== '-' ? ctx.shownArchitect : ''))}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" />
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-style-select" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelStyle', null, 'Архитектурный стиль:'))}</label>
          <select id="building-style-select" name="building-style-select" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">
            <option value="" ${ctx.styleEditState.selectedKey === '' ? 'selected' : ''}>${escapeHtml(t('modalStyleNotSet', null, 'Не указан'))}</option>
            ${ctx.styleOptionsHtml}
          </select>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <label for="building-archimap-description" class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalLabelExtraInfo', null, 'Доп. информация:'))}</label>
          <textarea id="building-archimap-description" name="building-archimap-description" rows="3" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200">${escapeHtml(info.archimap_description || info.description || '')}</textarea>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-slate-700 shadow-soft">
          <div class="mb-1 block text-xs font-bold text-slate-900">${escapeHtml(t('modalAddressTagsTitle', null, 'Адрес (OSM теги):'))}</div>
          <div class="mt-1.5 grid gap-1.5 md:grid-cols-2">
            <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressFull', null, 'Полный адрес (addr:full)'))}</span><input id="building-addr-full" name="building-addr-full" type="text" value="${escapeHtml(ctx.addressForm.full)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
            <label class="block"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressPostcode', null, 'Индекс (addr:postcode)'))}</span><input id="building-addr-postcode" name="building-addr-postcode" type="text" value="${escapeHtml(ctx.addressForm.postcode)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
            <label class="block"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressCity', null, 'Город (addr:city)'))}</span><input id="building-addr-city" name="building-addr-city" type="text" value="${escapeHtml(ctx.addressForm.city)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
            <label class="block"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressPlace', null, 'Место/локация (addr:place)'))}</span><input id="building-addr-place" name="building-addr-place" type="text" value="${escapeHtml(ctx.addressForm.place)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
            <label class="block"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressStreet', null, 'Улица (addr:street)'))}</span><input id="building-addr-street" name="building-addr-street" type="text" value="${escapeHtml(ctx.addressForm.street)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
            <label class="block md:col-span-2"><span class="mb-1 block text-xs font-semibold text-slate-700">${escapeHtml(t('modalAddressHouseNumber', null, 'Номер дома (addr:housenumber)'))}</span><input id="building-addr-housenumber" name="building-addr-housenumber" type="text" value="${escapeHtml(ctx.addressForm.housenumber)}" class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200" /></label>
          </div>
        </div>
        <div class="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5"><p id="building-save-status" class="text-sm text-slate-600"></p><button type="submit" class="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-700">${escapeHtml(t('modalSave', null, 'Сохранить'))}</button></div>
      </form>
    `
      : `
      ${ctx.isAuthenticated ? `<div class="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">${escapeHtml(t('modalEditRestricted', null, 'Редактирование доступно только пользователям с разрешением администратора.'))}</div>` : ''}
      ${buildReadonlyField(t('modalLabelName', null, 'Название:'), escapeHtml(ctx.shownName), escapeHtml)}
      ${buildReadonlyField(t('modalLabelAddress', null, 'Адрес:'), escapeHtml(ctx.shownAddress), escapeHtml)}
      ${buildReadonlyField(t('modalLabelLevels', null, 'Этажей:'), escapeHtml(ctx.shownLevels), escapeHtml)}
      ${buildReadonlyField(t('modalLabelYearBuilt', null, 'Год постройки:'), escapeHtml(ctx.shownYear), escapeHtml)}
      ${buildReadonlyField(t('modalLabelArchitect', null, 'Архитектор:'), buildCopyChips(splitSemicolonValues(ctx.info.architect || ctx.osmArchitect).map((raw) => ({ raw, label: raw })), ctx.shownArchitect, escapeHtml), escapeHtml)}
      ${buildReadonlyField(t('modalLabelStyle', null, 'Архитектурный стиль:'), buildCopyChips(splitSemicolonValues(ctx.info.style || ctx.osmStyle).map((raw) => ({ raw, label: ctx.toHumanArchitectureStyle(raw) || raw })), ctx.shownStyle, escapeHtml), escapeHtml)}
      ${buildReadonlyField(t('modalLabelDescription', null, 'Описание:'), escapeHtml(ctx.shownDescription), escapeHtml)}
      ${buildReadonlyField(t('modalLabelExtraInfo', null, 'Доп. информация:'), escapeHtml(ctx.shownExtraInfo), escapeHtml)}
    `;

    return `
    <div class="grid gap-2.5">
      ${editableRows}
      <details class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <summary class="relative cursor-pointer list-none bg-slate-50 px-3 py-2.5 pr-10 font-bold text-slate-900 transition hover:bg-slate-100 after:absolute after:right-3 after:top-1/2 after:-translate-y-1/2 after:content-['▾'] [&::-webkit-details-marker]:hidden [&[open]_summary]:after:rotate-180">${escapeHtml(t('modalOsmTagsSummary', null, 'OSM теги'))}</summary>
        <pre class="m-0 border-t border-slate-200 bg-white px-3 py-2.5 text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">${escapeHtml(JSON.stringify({
          osm: ctx.feature.properties?.osm_key || '-',
          ...ctx.osmTags
        }, null, 2))}</pre>
      </details>
    </div>
  `;
  }

  window.ArchiMapMainModal = {
    splitSemicolonValues,
    buildCopyChips,
    buildReadonlyField,
    buildModalHtml
  };
})();
