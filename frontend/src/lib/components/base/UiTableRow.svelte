<script>
  import { TableRow as PrimitiveTableRow } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
  export let onclick = undefined;
</script>

<PrimitiveTableRow class={cn(className)} {onclick} {...$$restProps}>
  <slot />
</PrimitiveTableRow>
