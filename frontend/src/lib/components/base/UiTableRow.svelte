<script>
  import { TableRow as PrimitiveTableRow } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveTableRow class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveTableRow>
