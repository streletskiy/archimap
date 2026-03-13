<script>
  import { Button as PrimitiveButton } from '$lib/components/ui/button';
  import { cn } from '$lib/utils/ui.js';

  export let variant = 'primary';
  export let size = 'default';
  export let href = undefined;
  export let type = 'button';
  export let className = '';
  export let onclick = undefined;
  export let onfocus = undefined;
  export let onblur = undefined;

  const variantMap = {
    primary: 'default',
    secondary: 'secondary',
    outline: 'outline',
    danger: 'destructive',
    ghost: 'ghost',
    link: 'link'
  };

  const sizeMap = {
    default: 'default',
    sm: 'sm',
    xs: 'sm',
    lg: 'lg',
    icon: 'icon',
    close: 'icon',
    'square-sm': 'icon-sm'
  };

  $: primitiveVariant = variantMap[variant] || 'default';
  $: primitiveSize = sizeMap[size] || 'default';
  $: sizeClassName = {
    xs: 'ui-button--size-xs',
    close: 'ui-button--size-close',
    'square-sm': 'ui-button--size-square-sm'
  }[size] || '';
</script>

<PrimitiveButton
  href={href}
  {type}
  variant={primitiveVariant}
  size={primitiveSize}
  {onclick}
  {onfocus}
  {onblur}
  class={cn(sizeClassName, className)}
  {...$$restProps}
>
  <slot />
</PrimitiveButton>
