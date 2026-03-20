<script>
  import { createEventDispatcher } from 'svelte';
  import { Switch as PrimitiveSwitch } from '$lib/components/ui/switch';
  import { cn } from '$lib/utils/ui.js';

  export let checked = false;
  export let className = '';
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  function handleCheckedChange(nextChecked) {
    const detail = { checked: Boolean(nextChecked) };
    checked = detail.checked;
    onchange?.({ detail });
    dispatch('change', detail);
  }
</script>

<PrimitiveSwitch
  bind:checked
  class={cn(className)}
  onCheckedChange={handleCheckedChange}
  {...$$restProps}
/>
