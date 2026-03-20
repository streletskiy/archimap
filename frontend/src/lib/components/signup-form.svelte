<script>
  import { UiButton, UiCard, UiInput, UiLabel } from '$lib/components/base';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { t } from '$lib/i18n/index';
  import AuthVisualPane from '$lib/components/shell/AuthVisualPane.svelte';

  export let firstName = '';
  export let lastName = '';
  export let email = '';
  export let password = '';
  export let passwordConfirm = '';
  export let pending = false;
  export let termsHref = '/info?tab=legal&doc=terms';
  export let privacyHref = '/info?tab=legal&doc=privacy';
  export let onsubmit = undefined;
  export let onclose = undefined;
  export let onswitch = undefined;

  function handleSubmit(event) {
    onsubmit?.(event);
  }
</script>

<div class="flex flex-col gap-6">
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
      <form class="auth-form-pane" on:submit={handleSubmit}>
        <div class="auth-form-stack">
          <div class="auth-form-copy">
            <h1 class="text-2xl font-bold">{$t('header.tabRegister')}</h1>
            <p class="text-muted-foreground text-sm text-balance">{$t('header.authSignupSubtitle')}</p>
          </div>

          <div class="auth-form-grid auth-form-grid--two">
            <div class="auth-form-field">
              <UiLabel for="auth-register-first-name">{$t('account.profile.firstName')}</UiLabel>
              <UiInput
                id="auth-register-first-name"
                type="text"
                bind:value={firstName}
                autocomplete="given-name"
              />
            </div>

            <div class="auth-form-field">
              <UiLabel for="auth-register-last-name">{$t('account.profile.lastName')}</UiLabel>
              <UiInput
                id="auth-register-last-name"
                type="text"
                bind:value={lastName}
                autocomplete="family-name"
              />
            </div>
          </div>

          <div class="auth-form-field">
            <UiLabel for="auth-register-email">{$t('header.email')} *</UiLabel>
            <UiInput
              id="auth-register-email"
              type="email"
              bind:value={email}
              placeholder="m@example.com"
              autocomplete="email"
              required
            />
          </div>

          <div class="auth-form-grid auth-form-grid--two">
            <div class="auth-form-field">
              <UiLabel for="auth-register-password">{$t('header.password')} *</UiLabel>
              <UiInput
                id="auth-register-password"
                type="password"
                bind:value={password}
                autocomplete="new-password"
                required
              />
            </div>

            <div class="auth-form-field">
              <UiLabel for="auth-register-confirm-password">{$t('header.repeatPassword')} *</UiLabel>
              <UiInput
                id="auth-register-confirm-password"
                type="password"
                bind:value={passwordConfirm}
                autocomplete="new-password"
                required
              />
            </div>
          </div>

          <p class="text-sm ui-text-muted">{$t('header.authPasswordHint')}</p>

          <UiButton type="submit" className="w-full" disabled={pending}>
            {$t('header.createAccount')}
          </UiButton>

          <p class="auth-footer-note">
            {$t('header.authHaveAccount')}
            <button
              type="button"
              class="auth-inline-link auth-inline-link--strong"
              on:click={() => onswitch?.()}
            >
              {$t('header.tabLogin')}
            </button>
          </p>
        </div>
      </form>

      <AuthVisualPane imageUrl="/images/auth/register.webp" />
    </div>
  </UiCard>

  <p class="auth-legal-note px-6 text-center text-sm">
    {$t('header.authLegalPrefix')}
    <a class="auth-legal-link" href={termsHref} target="_blank" rel="noopener noreferrer">
      {$t('header.termsLink')}
    </a>
    {$t('header.authLegalAnd')}
    <a class="auth-legal-link" href={privacyHref} target="_blank" rel="noopener noreferrer">
      {$t('header.privacyLink')}
    </a>.
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
    gap: 1.1rem;
  }

  .auth-form-copy {
    display: grid;
    gap: 0.45rem;
    text-align: center;
  }

  .auth-form-copy h1,
  .auth-footer-note {
    margin: 0;
  }

  .auth-form-grid {
    display: grid;
    gap: 1rem;
  }

  .auth-form-grid--two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .auth-form-field {
    display: grid;
    gap: 0.5rem;
  }

  .auth-inline-link {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--fg-strong);
    font-size: 0.875rem;
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .auth-inline-link--strong {
    margin-left: 0.35rem;
  }

  .auth-footer-note {
    text-align: center;
    font-size: 0.875rem;
    color: var(--muted);
  }

  .auth-legal-link {
    color: var(--fg-strong);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 0.18em;
  }

  @media (max-width: 639px) {
    .auth-form-grid--two {
      grid-template-columns: 1fr;
    }
  }

  @media (min-width: 768px) {
    .auth-form-pane {
      padding: 2rem;
    }
  }
</style>
