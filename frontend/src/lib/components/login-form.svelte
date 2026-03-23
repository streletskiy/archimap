<script>
  import { UiButton, UiCard, UiInput, UiLabel } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { t } from '$lib/i18n/index';
  import AuthVisualPane from '$lib/components/shell/AuthVisualPane.svelte';

  export let email = '';
  export let password = '';
  export let termsHref = '/info?tab=legal&doc=terms';
  export let privacyHref = '/info?tab=legal&doc=privacy';
  export let onsubmit = undefined;
  export let onforgot = undefined;
  export let onclose = undefined;
  export let onswitch = undefined;

  function handleSubmit(event) {
    onsubmit?.(event);
  }
</script>

<div class="flex flex-col gap-4">
  <UiCard className="relative overflow-hidden border-0 p-0 shadow-[0_28px_60px_rgba(8,17,31,0.24)]">
    <UiButton
      type="button"
      variant="secondary"
      size="close"
      className="absolute right-3.5 top-3.5 z-[2]"
      onclick={() => onclose?.()}
      aria-label={$t('common.close')}
    >
      <CloseIcon class="ui-close-icon" />
    </UiButton>

    <div class="grid p-0 md:min-h-[35rem] md:grid-cols-2">
      <form class="flex h-full flex-col justify-center p-6 md:p-8" on:submit={handleSubmit}>
        <div class="grid gap-6">
          <!-- Header -->
          <div class="grid gap-1.5 text-center">
            <h1 class="m-0 text-2xl font-bold">{$t('header.tabLogin')}</h1>
            <p class="m-0 text-sm text-muted-foreground text-balance">{$t('header.authLoginSubtitle')}</p>
          </div>

          <!-- Fields -->
          <div class="grid gap-4">
            <div class="grid gap-1.5">
              <UiLabel for="auth-login-email">{$t('header.email')}</UiLabel>
              <UiInput
                id="auth-login-email"
                type="email"
                bind:value={email}
                placeholder="m@example.com"
                autocomplete="email"
                required
              />
            </div>

            <div class="grid gap-1.5">
              <div class="flex items-baseline justify-between gap-2">
                <UiLabel for="auth-login-password">{$t('header.password')}</UiLabel>
                <button
                  type="button"
                  class="auth-link-inline"
                  on:click={() => onforgot?.()}
                >
                  {$t('header.forgotPassword')}
                </button>
              </div>
              <UiInput
                id="auth-login-password"
                type="password"
                bind:value={password}
                autocomplete="current-password"
                required
              />
            </div>
          </div>

          <!-- Actions -->
          <div class="grid gap-3">
            <UiButton type="submit" className="w-full">{$t('header.login')}</UiButton>

            <p class="m-0 text-center text-sm ui-text-muted">
              {$t('header.authNoAccount')}
              <button
                type="button"
                class="auth-link-inline font-bold ui-text-emphasis"
                on:click={() => onswitch?.()}
              >
                {$t('header.tabRegister')}
              </button>
            </p>
          </div>
        </div>
      </form>

      <AuthVisualPane imageUrl="/images/auth/login.webp" />
    </div>
  </UiCard>

  <p class="auth-legal-note m-0 px-8 text-center text-xs ui-text-muted text-balance">
    {$t('header.authLegalPrefix')}
    <a class="font-semibold underline underline-offset-2 ui-text-emphasis" href={termsHref} target="_blank" rel="noopener noreferrer">
      {$t('header.termsLink')}
    </a>
    {$t('header.authLegalAnd')}
    <a class="font-semibold underline underline-offset-2 ui-text-emphasis" href={privacyHref} target="_blank" rel="noopener noreferrer">
      {$t('header.privacyLink')}
    </a>.
  </p>
</div>

<style>
  .auth-link-inline {
    cursor: pointer;
    border: 0;
    background: transparent;
    padding: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.2;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
