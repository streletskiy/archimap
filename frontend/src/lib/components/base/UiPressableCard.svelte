<script>
  import { cn } from '$lib/utils/ui.js';

  export let selected = false;
  export let type = 'button';
  export let className = '';
  export let onclick = undefined;
</script>

<button
  {type}
  data-selected={selected ? 'true' : 'false'}
  {onclick}
  class={cn('ui-pressable-card px-3 py-2.5', className)}
  {...$$restProps}
>
  <slot />
</button>
