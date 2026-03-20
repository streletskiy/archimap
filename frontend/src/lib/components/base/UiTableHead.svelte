<script>
  import { TableHead as PrimitiveTableHead } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveTableHead class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveTableHead>
