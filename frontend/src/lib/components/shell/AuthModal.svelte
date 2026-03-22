<script>
  import { tick } from 'svelte';
  import { page } from '$app/stores';
  import { UiButton, UiInput } from '$lib/components/base';
  import LoginForm from '$lib/components/login-form.svelte';
  import SignupForm from '$lib/components/signup-form.svelte';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { setSession } from '$lib/stores/auth';
  import AuthCardShell from './AuthCardShell.svelte';

  export let open = false;
  export let preferredTab = 'login';
  export let requestId = 0;
  export let termsHref = '/info?tab=legal&doc=terms';
  export let privacyHref = '/info?tab=legal&doc=privacy';

  let loginEmail = '';
  let loginPassword = '';
  let regEmail = '';
  let regPassword = '';
  let regPasswordConfirm = '';
  let regFirstName = '';
  let regLastName = '';
  let regCode = '';
  let regAcceptTerms = true;
  let regAcceptPrivacy = true;
  let registerPendingEmail = '';
  let registerStartInFlight = false;
  let registerCodeReady = false;
  let resetEmail = '';
  let resetToken = '';
  let resetNewPassword = '';
  let status = '';
  let authTab = 'login';
  let resetMode = false;
  let handledRegisterToken = '';
  let handledResetToken = '';
  let lastHandledRequestId;
  let modalEl = null;
  let hadOpenState;
  let authModalWidthClass;

  $: if (requestId && requestId !== lastHandledRequestId) {
    lastHandledRequestId = requestId;
    authTab = preferredTab === 'register' ? 'register' : 'login';
    resetMode = false;
    registerPendingEmail = '';
    registerCodeReady = false;
    regCode = '';
    status = '';
    open = true;
  }
  $: void lastHandledRequestId;

  $: {
    const registerTokenFromQuery = $page.url.searchParams.get('registerToken');
    if (registerTokenFromQuery) {
      handleRegisterTokenFromQuery(registerTokenFromQuery);
    }
  }

  $: {
    const resetTokenFromQuery = $page.url.searchParams.get('resetToken') || $page.url.searchParams.get('reset');
    if (resetTokenFromQuery) {
      handleResetTokenFromQuery(resetTokenFromQuery);
    }
  }

  function closeAuth() {
    open = false;
  }

  function closeOnKeydown(event) {
    if (event.key === 'Escape') {
      closeAuth();
    }
  }

  function showAuthTab(tab) {
    authTab = tab === 'register' ? 'register' : 'login';
    resetMode = false;
    status = '';
  }

  function openResetMode() {
    resetMode = true;
    authTab = 'login';
    status = '';
  }

  async function submitLogin(event) {
    event.preventDefault();
    status = translateNow('header.status.loginInProgress');
    try {
      const data = await apiJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });
      setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
      status = translateNow('header.status.loginDone');
      loginPassword = '';
      closeAuth();
    } catch (error) {
      status = String(error.message || translateNow('header.status.loginFailed'));
    }
  }

  async function submitRegisterStart(event) {
    event.preventDefault();
    if (registerStartInFlight) return;

    const email = String(regEmail || '').trim();
    const password = String(regPassword || '');
    const passwordConfirm = String(regPasswordConfirm || '');

    if (!email) {
      status = translateNow('header.status.registerNeedEmail');
      return;
    }
    if (password.length < 8) {
      status = translateNow('header.status.registerPasswordMin');
      return;
    }
    if (password !== passwordConfirm) {
      status = translateNow('header.status.registerPasswordMismatch');
      return;
    }
    registerPendingEmail = email;
    registerCodeReady = false;
    registerStartInFlight = true;
    status = translateNow('header.status.registerCodeSending');

    try {
      await apiJson('/api/register/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          firstName: regFirstName,
          lastName: regLastName,
          acceptTerms: regAcceptTerms,
          acceptPrivacy: regAcceptPrivacy
        })
      });
      registerCodeReady = true;
      status = translateNow('header.status.registerCodeSent');
    } catch (error) {
      registerPendingEmail = '';
      registerCodeReady = false;
      regCode = '';
      status = String(error.message || translateNow('header.status.registerStartFailed'));
    } finally {
      registerStartInFlight = false;
    }
  }

  async function submitRegisterConfirm(event) {
    event.preventDefault();
    if (!registerCodeReady) {
      status = translateNow('header.status.registerCodeSending');
      return;
    }
    status = translateNow('header.status.confirmingCode');
    try {
      const data = await apiJson('/api/register/confirm-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: registerPendingEmail, code: regCode })
      });
      setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
      status = translateNow('header.status.registerConfirmed');
      closeAuth();
    } catch (error) {
      status = String(error.message || translateNow('header.status.confirmCodeFailed'));
    }
  }

  async function submitResetRequest(event) {
    event.preventDefault();
    status = translateNow('header.status.resetSending');
    try {
      await apiJson('/api/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail })
      });
      status = translateNow('header.status.resetRequested');
    } catch (error) {
      status = String(error.message || translateNow('header.status.resetRequestFailed'));
    }
  }

  async function submitResetConfirm(event) {
    event.preventDefault();
    status = translateNow('header.status.resetConfirming');
    try {
      await apiJson('/api/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: resetNewPassword })
      });
      status = translateNow('header.status.resetDone');
      resetToken = '';
      resetNewPassword = '';
      resetMode = false;
      authTab = 'login';
    } catch (error) {
      status = String(error.message || translateNow('header.status.resetFailed'));
    }
  }

  function stripAuthQueryParams(params) {
    if (typeof window === 'undefined') return;
    const next = new URL(window.location.href);
    let changed = false;
    for (const key of params) {
      if (next.searchParams.has(key)) {
        next.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    const query = next.searchParams.toString();
    const suffix = query ? `?${query}` : '';
    window.history.replaceState(window.history.state, '', `${next.pathname}${suffix}${next.hash}`);
  }

  async function handleRegisterTokenFromQuery(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token || token === handledRegisterToken) return;
    handledRegisterToken = token;
    status = translateNow('header.status.registerLinkConfirming');
    try {
      const data = await apiJson('/api/register/confirm-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      setSession({ authenticated: true, user: data.user, csrfToken: data.csrfToken });
      status = translateNow('header.status.registerConfirmed');
      open = false;
    } catch (error) {
      status = String(error.message || translateNow('header.status.registerLinkFailed'));
      authTab = 'register';
      open = true;
    } finally {
      stripAuthQueryParams(['registerToken']);
    }
  }

  function handleResetTokenFromQuery(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token || token === handledResetToken) return;
    handledResetToken = token;
    resetToken = token;
    resetMode = true;
    authTab = 'login';
    open = true;
    stripAuthQueryParams(['resetToken', 'reset', 'auth']);
  }

  $: if (open && !hadOpenState) {
    hadOpenState = true;
    tick().then(() => modalEl?.focus());
  } else if (!open && hadOpenState) {
    hadOpenState = false;
  }
  $: void hadOpenState;

  $: authModalWidthClass = registerPendingEmail || resetMode
    ? 'auth-modal w-full max-w-sm md:max-w-3xl'
    : 'auth-modal w-full max-w-sm md:max-w-4xl';
</script>

{#if open}
  <div class:auth-backdrop-mobile-top={registerPendingEmail || resetMode || authTab === 'register'} class="auth-backdrop">
    <button
      type="button"
      class="auth-dismiss-layer"
      tabindex="-1"
      aria-label={$t('common.close')}
      on:click={closeAuth}
    ></button>

    <div
      class={authModalWidthClass}
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      tabindex="-1"
      on:keydown={closeOnKeydown}
    >
      {#if registerPendingEmail || resetMode}
        <UiButton
          type="button"
          variant="secondary"
          size="close"
          className="auth-modal-close"
          onclick={closeAuth}
          aria-label={$t('common.close')}
        >
          <CloseIcon class="ui-close-icon" />
        </UiButton>
      {/if}

      {#if registerPendingEmail}
        <AuthCardShell
          title={$t('header.confirmRegistration')}
          subtitle={$t('header.authConfirmSubtitle')}
          bodyClassName="grid content-center"
        >
          <h2 id="auth-modal-title" class="sr-only">{$t('header.confirmRegistration')}</h2>
          <form class="auth-stage-form" on:submit={submitRegisterConfirm}>
            <UiInput value={registerPendingEmail} readonly />
            <UiInput
              bind:value={regCode}
              inputmode="numeric"
              maxlength="6"
              placeholder="123456"
              required
            />
            <UiButton type="submit" className="w-full" disabled={!registerCodeReady}>
              {$t('header.confirmCode')}
            </UiButton>
          </form>
        </AuthCardShell>
      {:else if resetMode}
        <AuthCardShell
          title={$t('header.changePassword')}
          subtitle={$t('header.authResetSubtitle')}
          bodyClassName="grid content-center"
        >
          <h2 id="auth-modal-title" class="sr-only">{$t('header.changePassword')}</h2>
          <div class="auth-stage-stack">
            <form class="auth-stage-form" on:submit={submitResetRequest}>
              <UiInput
                bind:value={resetEmail}
                type="email"
                placeholder={$t('header.emailAccount')}
                required
                autocomplete="email"
              />
              <UiButton variant="secondary" type="submit" className="w-full">
                {$t('header.sendResetLink')}
              </UiButton>
            </form>

            <div class="auth-stage-divider" aria-hidden="true"></div>

            <form class="auth-stage-form" on:submit={submitResetConfirm}>
              <UiInput bind:value={resetToken} placeholder={$t('header.resetToken')} required />
              <UiInput
                bind:value={resetNewPassword}
                type="password"
                placeholder={$t('header.newPassword')}
                required
                autocomplete="new-password"
              />
              <UiButton type="submit" className="w-full">
                {$t('header.changePassword')}
              </UiButton>
            </form>

            <button type="button" class="auth-stage-link" on:click={() => showAuthTab('login')}>
              {$t('header.login')}
            </button>
          </div>
        </AuthCardShell>
      {:else if authTab === 'register'}
        <div aria-labelledby="auth-modal-title">
          <h2 id="auth-modal-title" class="sr-only">{$t('header.tabRegister')}</h2>
          <SignupForm
            bind:firstName={regFirstName}
            bind:lastName={regLastName}
            bind:email={regEmail}
            bind:password={regPassword}
            bind:passwordConfirm={regPasswordConfirm}
            {termsHref}
            {privacyHref}
            pending={registerStartInFlight}
            onsubmit={submitRegisterStart}
            onclose={closeAuth}
            onswitch={() => showAuthTab('login')}
          />
        </div>
      {:else}
        <div aria-labelledby="auth-modal-title">
          <h2 id="auth-modal-title" class="sr-only">{$t('header.tabLogin')}</h2>
          <LoginForm
            bind:email={loginEmail}
            bind:password={loginPassword}
            {termsHref}
            {privacyHref}
            onsubmit={submitLogin}
            onforgot={openResetMode}
            onclose={closeAuth}
            onswitch={() => showAuthTab('register')}
          />
        </div>
      {/if}

      {#if status}
        <p class="status">{status}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .auth-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    padding: 1rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    background: rgba(8, 17, 31, 0.44);
    backdrop-filter: blur(10px);
    pointer-events: auto;
  }

  .auth-dismiss-layer {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .auth-modal {
    position: relative;
    z-index: 1;
    pointer-events: auto;
  }

  .auth-modal-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 5;
  }

  .auth-stage-stack,
  .auth-stage-form {
    display: grid;
    gap: 0.9rem;
  }

  .auth-stage-divider {
    height: 1px;
    background: var(--panel-border);
    opacity: 0.75;
  }

  .auth-stage-link {
    justify-self: start;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--accent-ink);
    font-size: 0.88rem;
    font-weight: 700;
    cursor: pointer;
  }

  .status {
    margin: 0.85rem 0 0;
    padding: 0.8rem 0.95rem;
    border-radius: 1rem;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 82%, transparent);
    color: var(--muted-strong);
    font-size: 0.85rem;
    line-height: 1.45;
    backdrop-filter: blur(16px);
  }

  @media (min-width: 768px) {
    .auth-modal-close {
      top: 1rem;
      right: 1rem;
    }
  }

  @media (max-width: 767px) {
    .auth-backdrop-mobile-top {
      place-items: start center;
      padding-top: 1rem;
    }

    .auth-backdrop {
      padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    }

    .auth-modal {
      width: 100%;
    }
  }
</style>
