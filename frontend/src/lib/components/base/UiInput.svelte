<script>
  import { Input as PrimitiveInput } from '$lib/components/ui/input';
  import { cn } from '$lib/utils/ui.js';

  export let value = '';
  export let size = 'default';
  export let className = '';
  export let oninput = undefined;
  export let onchange = undefined;
  export let onfocus = undefined;
  export let onblur = undefined;
  export let onkeydown = undefined;
  export let onkeyup = undefined;
  let inputRef = null;

  export function focus() {
    inputRef?.focus();
  }

  export function blur() {
    inputRef?.blur();
  }

  export function select() {
    inputRef?.select?.();
  }
</script>

<PrimitiveInput
  bind:ref={inputRef}
  bind:value
  {oninput}
  {onchange}
  {onfocus}
  {onblur}
  {onkeydown}
  {onkeyup}
  class={cn(size === 'xs' && 'ui-input--xs', className)}
  {...$$restProps}
/>
