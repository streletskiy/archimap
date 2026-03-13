<script>
  import { Badge as PrimitiveBadge } from '$lib/components/ui/badge';
  import { cn } from '$lib/utils/ui.js';

  export let variant = 'default';
  export let href = undefined;
  export let className = '';

  $: variantClassName = {
    default: '',
    accent: 'ui-badge--accent',
    secondary: 'ui-badge--secondary',
    danger: 'ui-badge--destructive',
    warning: 'ui-badge--warning',
    info: 'ui-badge--info',
    success: 'ui-badge--success',
    outline: 'ui-badge--outline'
  }[variant] || '';
</script>

<PrimitiveBadge
  {href}
  variant="default"
  class={cn(variantClassName, className)}
  {...$$restProps}
>
  <slot />
</PrimitiveBadge>
