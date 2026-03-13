<script>
  import { TableCell as PrimitiveTableCell } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveTableCell class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveTableCell>
