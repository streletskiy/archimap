<script>
  import { Table as PrimitiveTable } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
  export let containerClassName = '';
</script>

<PrimitiveTable
  containerClass={cn('ui-table-surface', containerClassName)}
  class={cn(className)}
  {...$$restProps}
>
  <slot />
</PrimitiveTable>
