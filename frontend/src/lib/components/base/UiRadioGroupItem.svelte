<script>
  import { RadioGroupItem as PrimitiveRadioGroupItem } from '$lib/components/ui/radio-group';
  import { cn } from '$lib/utils/ui.js';

  export let className = '';
</script>

<PrimitiveRadioGroupItem
  class={cn(className)}
  {...$$restProps}
/>
