<script>
  import { ScrollArea as PrimitiveScrollArea } from '$lib/components/ui/scroll-area';
  import { cn } from '$lib/utils/ui.js';

  export let ref = null;
  export let viewportRef = null;
  export let orientation = 'vertical';
  export let className = '';
  export let contentClassName = '';
  export let scrollbarXClassName = '';
  export let scrollbarYClassName = '';
</script>

<PrimitiveScrollArea
  bind:ref
  bind:viewportRef
  {orientation}
  class={cn('min-h-0 rounded-[inherit]', className)}
  scrollbarXClasses={scrollbarXClassName}
  scrollbarYClasses={scrollbarYClassName}
  {...$$restProps}
>
  <div class={cn('min-w-full', contentClassName)}>
    <slot />
  </div>
</PrimitiveScrollArea>
