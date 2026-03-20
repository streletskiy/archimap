<script>
  import { UiCard } from '$lib/components/base';
  import { t } from '$lib/i18n/index';
  import AuthVisualPane from '$lib/components/shell/AuthVisualPane.svelte';
  import { cn } from '$lib/utils/ui.js';

  export let title = '';
  export let subtitle = '';
  export let className = '';
  export let bodyClassName = '';
</script>

<UiCard
  className={cn(
    'overflow-hidden border-0 p-0 shadow-[0_28px_60px_rgba(8,17,31,0.24)]',
    className
  )}
>
  <div class="grid p-0 md:grid-cols-2">
    <div class={cn('p-6 md:p-8', bodyClassName)}>
      <div class="auth-card-copy">
        <p class="auth-card-kicker">{$t('common.appName')}</p>
        <h2>{title}</h2>
        {#if subtitle}
          <p>{subtitle}</p>
        {/if}
      </div>
      <slot />
    </div>
    <AuthVisualPane />
  </div>
</UiCard>

<style>
  .auth-card-copy {
    display: grid;
    gap: 0.45rem;
    margin-bottom: 1.4rem;
  }

  .auth-card-kicker {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .auth-card-copy h2 {
    margin: 0;
    font-size: clamp(1.55rem, 2.6vw, 2rem);
    line-height: 1.05;
    color: var(--fg-strong);
  }

  .auth-card-copy > p:last-child {
    margin: 0;
    max-width: 32rem;
    color: var(--muted-strong);
    font-size: 0.95rem;
    line-height: 1.5;
  }
</style>
