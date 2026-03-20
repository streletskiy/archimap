<script>
  import { UiCard } from '$lib/components/base';

  export let eyebrow = '';
  export let title = '';
  export let description = '';
  export let pageClass = '';
  export let shellClass = '';

  $: rootClassName = ['portal-page', pageClass].filter(Boolean).join(' ');
  $: shellClassName = ['portal-shell', shellClass].filter(Boolean).join(' ');
</script>

<main class={rootClassName}>
  <UiCard className={shellClassName}>
    <header class="portal-hero">
      <div class="portal-hero-main">
        {#if eyebrow}
          <p class="ui-kicker">{eyebrow}</p>
        {/if}
        <h1>{title}</h1>
        {#if description}
          <p>{description}</p>
        {/if}
      </div>

      {#if $$slots.meta}
        <div class="portal-hero-meta">
          <slot name="meta" />
        </div>
      {/if}

      {#if $$slots.actions}
        <div class="portal-hero-actions">
          <slot name="actions" />
        </div>
      {/if}
    </header>

    {#if $$slots.lead}
      <div class="portal-lead">
        <slot name="lead" />
      </div>
    {/if}

    <div class="portal-body">
      <slot />
    </div>
  </UiCard>
</main>
