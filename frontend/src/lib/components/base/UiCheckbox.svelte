<script>
  import { createEventDispatcher } from 'svelte';
  import { Checkbox as PrimitiveCheckbox } from '$lib/components/ui/checkbox';
  import { cn } from '$lib/utils/ui.js';

  export let checked = false;
  export let className = '';
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  function handleCheckedChange(nextChecked) {
    checked = Boolean(nextChecked);
    const detail = { checked };
    onchange?.({ detail });
    dispatch('change', detail);
  }
</script>

<PrimitiveCheckbox
  bind:checked
  onCheckedChange={handleCheckedChange}
  class={cn(className)}
  {...$$restProps}
/>
