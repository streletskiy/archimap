<script>
  import { createEventDispatcher } from 'svelte';
  import * as Select from '$lib/components/ui/select';
  import { cn } from '$lib/utils/ui.js';

  export let value = null;
  export let items = [];
  export let size = 'default';
  export let placeholder = '';
  export let className = '';
  export let contentClassName = '';
  export let itemClassName = '';
  export let disabled = false;
  export let onchange = undefined;
  const dispatch = createEventDispatcher();
  let normalizedItems = [];
  let selectItems;
  let selectedKey = '';
  let selectedItem;

  function serializeValue(nextValue) {
    return nextValue === null || nextValue === undefined ? '' : JSON.stringify(nextValue);
  }

  function handleValueChange(nextKey = '') {
    selectedKey = String(nextKey || '');
    const match = normalizedItems.find((item) => item.key === selectedKey);
    const nextValue = match ? match.value : null;
    if (serializeValue(nextValue) !== serializeValue(value)) {
      value = nextValue;
    }
    const detail = {
      value: nextValue,
      item: match || null
    };
    onchange?.({ detail });
    dispatch('change', detail);
  }

  $: normalizedItems = items.map((item) => ({
    ...item,
    key: serializeValue(item.value)
  }));
  $: selectItems = normalizedItems.map((item) => ({
    value: item.key,
    label: item.label,
    disabled: item.disabled
  }));
  $: {
    const nextSelectedKey = serializeValue(value);
    if (nextSelectedKey !== selectedKey) {
      selectedKey = nextSelectedKey;
    }
  }
  $: selectedItem = normalizedItems.find((item) => item.key === selectedKey) || null;
</script>

<Select.Root
  type="single"
  value={selectedKey}
  items={selectItems}
  onValueChange={handleValueChange}
  {disabled}
  {...$$restProps}
>
  <Select.Trigger
    size={size === 'xs' ? 'sm' : 'default'}
    class={cn(className)}
    title={selectedItem ? selectedItem.label : placeholder}
  >
    <span class="ui-select-trigger-value">
      {selectedItem ? selectedItem.label : placeholder}
    </span>
  </Select.Trigger>
  <Select.Content class={cn(contentClassName)}>
    {#each normalizedItems as item (item.key)}
      <Select.Item
        value={item.key}
        label={item.label}
        disabled={item.disabled}
        class={cn(itemClassName)}
      />
    {/each}
  </Select.Content>
</Select.Root>
