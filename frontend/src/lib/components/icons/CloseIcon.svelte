<script>
  export let size = 24;
  export let width = size;
  export let height = size;
  export let title = '';
</script>

<svg
  viewBox="0 0 24 24"
  fill="none"
  {width}
  {height}
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
  {...$$restProps}
>
  {#if title}
    <title>{title}</title>
  {/if}
  <path d="M6 6L18 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
  <path d="M18 6L6 18" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
</svg>
