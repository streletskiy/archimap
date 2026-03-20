<script>
  import { Card as PrimitiveCard } from '$lib/components/ui/card';
  import { cn } from '$lib/utils/ui.js';

  export let padded = false;
  export let className = '';
</script>

<PrimitiveCard
  class={cn(
    'ui-card-surface gap-0 py-0',
    padded && 'p-4',
    className
  )}
  {...$$restProps}
>
  <slot />
</PrimitiveCard>
