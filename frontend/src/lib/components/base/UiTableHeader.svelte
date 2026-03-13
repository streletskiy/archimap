<script>
  import { TableHeader as PrimitiveTableHeader } from '$lib/components/ui/table';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveTableHeader class={cn(className)} {...$$restProps}>
  <slot />
</PrimitiveTableHeader>
