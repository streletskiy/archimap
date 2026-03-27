<script>
  import { locale, t } from '$lib/i18n/index';

  import { UiButton, UiDateRangePicker, UiInput, UiSelect } from '$lib/components/base';

  export let editsQuery = '';
  export let editsDateRange = undefined;
  export let editsUser = '';
  export let editsUserItems = [];
  export let editsFilter = 'all';
  export let editsFilterItems = [];
  export let page = 1;
  export let loading = false;
  export let onFilterChange = () => {};
  export let onRefresh = () => {};
</script>

<div class="ui-filter-toolbar ui-filter-toolbar--admin-edits">
  <UiInput
    type="search"
    placeholder={$t('admin.edits.search')}
    bind:value={editsQuery}
    oninput={() => onFilterChange(1)}
  />
  <UiDateRangePicker
    value={editsDateRange}
    locale={$locale}
    placeholder={$t('admin.edits.dateRangePlaceholder')}
    calendarLabel={$t('admin.edits.dateRangeLabel')}
    clearLabel={$t('common.clear')}
    onchange={(event) => {
      editsDateRange = event.detail.value;
      if (!event.detail.value?.start || event.detail.value?.end) {
        onFilterChange(1);
      }
    }}
  />
  <UiSelect
    items={editsUserItems}
    bind:value={editsUser}
    contentClassName="max-h-72"
    onchange={() => onFilterChange(1)}
  />
  <UiSelect items={editsFilterItems} bind:value={editsFilter} onchange={() => onFilterChange(1)} />
  <UiButton
    type="button"
    variant="secondary"
    className="w-full min-h-11 rounded-[1rem] px-4 py-3 text-sm sm:w-auto"
    onclick={() => onRefresh(page)}
    disabled={loading}
  >
    {$t('common.refresh')}
  </UiButton>
</div>

