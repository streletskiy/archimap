<script>
  import { Textarea as PrimitiveTextarea } from '$lib/components/ui/textarea';
  import { cn } from '$lib/utils/ui.js';

  export let value = '';
  export let className = '';
  export let oninput = undefined;
  export let onchange = undefined;
  export let onfocus = undefined;
  export let onblur = undefined;
  export let onkeydown = undefined;
  export let onkeyup = undefined;
</script>

<PrimitiveTextarea
  bind:value
  {oninput}
  {onchange}
  {onfocus}
  {onblur}
  {onkeydown}
  {onkeyup}
  class={cn(className)}
  {...$$restProps}
/>
