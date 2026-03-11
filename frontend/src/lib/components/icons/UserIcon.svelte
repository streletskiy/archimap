<script>
  export let size = 20;
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
  <path
    d="M20 21a8 8 0 0 0-16 0"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <path
    d="M12 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8z"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
