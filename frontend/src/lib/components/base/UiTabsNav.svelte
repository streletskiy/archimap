<script>
  import { createEventDispatcher } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { cn } from '$lib/utils/ui.js';

  export let value = '';
  export let items = [];
  export let className = '';
  export let listClassName = '';
  export let triggerClassName = '';
  export let onchange = undefined;

  const dispatch = createEventDispatcher();
  let lastDispatchedValue = value;

  $: if (value !== lastDispatchedValue) {
    lastDispatchedValue = value;
    const detail = { value };
    onchange?.({ detail });
    dispatch('change', detail);
  }
</script>

<Tabs.Root bind:value>
  <Tabs.List class={cn('w-full', className, listClassName)}>
    {#each items as item (item.value)}
      <Tabs.Trigger value={item.value} disabled={item.disabled} class={cn(triggerClassName)}>
        {item.label}
      </Tabs.Trigger>
    {/each}
  </Tabs.List>
</Tabs.Root>
