<script>
  import { Table as PrimitiveTable } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
  export let containerClassName = '';
  export let framed = true;
</script>

<PrimitiveTable
  containerClass={cn(framed ? 'ui-table-surface' : '', containerClassName)}
  class={cn(className)}
  {...$$restProps}
>
  <slot />
</PrimitiveTable>
