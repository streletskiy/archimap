<script>
  import { TableBody as PrimitiveTableBody } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveTableBody class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveTableBody>
