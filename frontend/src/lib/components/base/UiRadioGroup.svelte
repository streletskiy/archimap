<script>
  import { createEventDispatcher } from 'svelte';
  import { RadioGroup as PrimitiveRadioGroup } from '$lib/components/ui/radio-group';
  import { cn } from '$lib/utils/ui.js';

  export let value = '';
  export let className = '';
  export let onchange = undefined;

  const dispatch = createEventDispatcher();

  function handleValueChange(nextValue = '') {
    value = String(nextValue || '');
    const detail = { value };
    onchange?.({ detail });
    dispatch('change', detail);
  }
</script>

<PrimitiveRadioGroup
  bind:value
  onValueChange={handleValueChange}
  class={cn('gap-2.5', className)}
  {...$$restProps}
>
  <slot />
</PrimitiveRadioGroup>
