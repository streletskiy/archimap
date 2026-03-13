<script>
  import { UiButton, UiCard, UiInput, UiLabel } from '$lib/components/base';
  import { t } from '$lib/i18n/index';
  import AuthVisualPane from '$lib/components/shell/AuthVisualPane.svelte';

  export let email = '';
  export let password = '';
  export let termsHref = '/info?tab=legal&doc=terms';
  export let privacyHref = '/info?tab=legal&doc=privacy';
  export let onsubmit = undefined;
  export let onforgot = undefined;
  export let onswitch = undefined;

  function handleSubmit(event) {
    onsubmit?.(event);
  }
</script>

<div class="flex flex-col gap-6">
  <UiCard className="overflow-hidden border-0 p-0 shadow-[0_28px_60px_rgba(8,17,31,0.24)]">
    <div class="grid p-0 md:min-h-[35rem] md:grid-cols-2">
      <form class="auth-form-pane" on:submit={handleSubmit}>
        <div class="auth-form-stack">
          <div class="auth-form-copy">
            <h1 class="text-2xl font-bold">{$t('header.tabLogin')}</h1>
            <p class="text-muted-foreground text-balance">{$t('header.authLoginSubtitle')}</p>
          </div>

          <div class="auth-form-field">
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

          <div class="auth-form-field">
            <div class="auth-form-field-head">
              <UiLabel for="auth-login-password">{$t('header.password')}</UiLabel>
              <button
                type="button"
                class="auth-inline-link"
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

          <UiButton type="submit" className="w-full">{$t('header.login')}</UiButton>

          <p class="auth-footer-note">
            {$t('header.authNoAccount')}
            <button
              type="button"
              class="auth-inline-link auth-inline-link--strong"
              on:click={() => onswitch?.()}
            >
              {$t('header.tabRegister')}
            </button>
          </p>
        </div>
      </form>

      <AuthVisualPane />
    </div>
  </UiCard>

  <p class="auth-legal-note px-6 text-center text-sm">
    {$t('header.authLegalPrefix')}
    <a href={termsHref}>{$t('header.termsLink')}</a>
    {$t('header.authLegalAnd')}
    <a href={privacyHref}>{$t('header.privacyLink')}</a>.
  </p>
</div>

<style>
  .auth-form-pane {
    display: flex;
    height: 100%;
    flex-direction: column;
    justify-content: center;
    padding: 1.5rem;
  }

  .auth-form-stack {
    display: grid;
    gap: 1.25rem;
  }

  .auth-form-copy {
    display: grid;
    gap: 0.5rem;
    text-align: center;
  }

  .auth-form-copy h1,
  .auth-footer-note {
    margin: 0;
  }

  .auth-form-field {
    display: grid;
    gap: 0.5rem;
  }

  .auth-form-field-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .auth-form-field-head :global(.ui-label) {
    min-width: 0;
  }

  .auth-inline-link {
    margin-left: auto;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--muted-strong);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .auth-inline-link--strong {
    margin-left: 0.35rem;
    color: var(--fg-strong);
    font-weight: 700;
  }

  .auth-footer-note {
    text-align: center;
    font-size: 0.875rem;
    color: var(--muted);
  }

  @media (min-width: 768px) {
    .auth-form-pane {
      padding: 2rem;
    }
  }
</style>
