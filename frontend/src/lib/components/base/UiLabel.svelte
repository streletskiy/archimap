<script>
  import { Label as PrimitiveLabel } from '$lib/components/ui/label';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveLabel class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveLabel>
