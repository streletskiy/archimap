<script>
  import { tick } from 'svelte';
  import { page } from '$app/stores';
  import CloseIcon from '$lib/components/icons/CloseIcon.svelte';
  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';
  import { clearSession, setSession } from '$lib/stores/auth';

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
  let regAcceptTerms = false;
  let regAcceptPrivacy = false;
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
  let lastHandledRequestId = 0;
  let modalEl = null;
  let hadOpenState = false;

  $: if (requestId && requestId !== lastHandledRequestId) {
    lastHandledRequestId = requestId;
    authTab = preferredTab === 'register' ? 'register' : 'login';
    resetMode = false;
    open = true;
  }

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
    if (!regAcceptTerms || !regAcceptPrivacy) {
      status = translateNow('header.status.registerNeedConsents');
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
</script>

{#if open}
  <div class="auth-backdrop">
    <button
      type="button"
      class="auth-dismiss-layer"
      tabindex="-1"
      aria-label={$t('common.close')}
      on:click={closeAuth}
    ></button>

    <div
      class="auth-modal"
      bind:this={modalEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
      tabindex="-1"
      on:keydown={closeOnKeydown}
    >
      <div class="auth-head">
        <div class="auth-head-copy">
          <p class="ui-kicker">{$t('common.appName')}</p>
          <h3 id="auth-modal-title">{$t('header.authTitle')}</h3>
        </div>
        <button
          type="button"
          class="ui-btn ui-btn-secondary ui-btn-xs ui-btn-close"
          on:click={closeAuth}
          aria-label={$t('common.close')}
        >
          <CloseIcon class="ui-close-icon" />
        </button>
      </div>

      {#if registerPendingEmail}
        <form class="stack" on:submit={submitRegisterConfirm}>
          <p class="hint">{$t('header.confirmRegistration')}</p>
          <input class="ui-field" value={registerPendingEmail} readonly />
          <input
            class="ui-field"
            bind:value={regCode}
            inputmode="numeric"
            maxlength="6"
            placeholder="123456"
            required
          />
          <button class="ui-btn ui-btn-secondary" type="submit" disabled={!registerCodeReady}>
            {$t('header.confirmCode')}
          </button>
        </form>
      {:else if resetMode}
        <form class="stack" on:submit={submitResetRequest}>
          <input
            class="ui-field"
            bind:value={resetEmail}
            type="email"
            placeholder={$t('header.emailAccount')}
            required
          />
          <button class="ui-btn ui-btn-secondary" type="submit">{$t('header.sendResetLink')}</button>
        </form>
        <form class="stack" on:submit={submitResetConfirm}>
          <input class="ui-field" bind:value={resetToken} placeholder={$t('header.resetToken')} required />
          <input
            class="ui-field"
            bind:value={resetNewPassword}
            type="password"
            placeholder={$t('header.newPassword')}
            required
          />
          <button class="ui-btn ui-btn-primary" type="submit">{$t('header.changePassword')}</button>
        </form>
      {:else}
        <div class="tabs ui-tab-shell">
          <button
            type="button"
            class="ui-tab-btn"
            class:ui-tab-btn-active={authTab === 'login'}
            on:click={() => (authTab = 'login')}
          >
            {$t('header.tabLogin')}
          </button>
          <button
            type="button"
            class="ui-tab-btn"
            class:ui-tab-btn-active={authTab === 'register'}
            on:click={() => (authTab = 'register')}
          >
            {$t('header.tabRegister')}
          </button>
        </div>

        {#if authTab === 'login'}
          <form class="stack" on:submit={submitLogin}>
            <input class="ui-field" bind:value={loginEmail} type="email" placeholder={$t('header.email')} required />
            <input
              class="ui-field"
              bind:value={loginPassword}
              type="password"
              placeholder={$t('header.password')}
              required
            />
            <button type="button" class="forgot-btn" on:click={() => (resetMode = true)}>
              {$t('header.forgotPassword')}
            </button>
            <button class="ui-btn ui-btn-primary" type="submit">{$t('header.login')}</button>
          </form>
        {:else}
          <form class="stack" on:submit={submitRegisterStart}>
            <input class="ui-field" bind:value={regFirstName} placeholder={$t('header.firstName')} />
            <input class="ui-field" bind:value={regLastName} placeholder={$t('header.lastName')} />
            <input
              class="ui-field"
              bind:value={regEmail}
              type="email"
              placeholder={$t('header.emailRequired')}
              required
              aria-required="true"
            />
            <input
              class="ui-field"
              bind:value={regPassword}
              type="password"
              placeholder={$t('header.passwordRequired')}
              required
              aria-required="true"
            />
            <input
              class="ui-field"
              bind:value={regPasswordConfirm}
              type="password"
              placeholder={$t('header.repeatPassword')}
              required
            />
            <label class="consent">
              <input type="checkbox" bind:checked={regAcceptTerms} required aria-required="true" />
              <span>{$t('header.acceptTerms')} <a href={termsHref}>{$t('header.termsLink')}</a></span>
            </label>
            <label class="consent">
              <input type="checkbox" bind:checked={regAcceptPrivacy} required aria-required="true" />
              <span>{$t('header.acceptPrivacy')} <a href={privacyHref}>{$t('header.privacyLink')}</a></span>
            </label>
            <button class="ui-btn ui-btn-primary" type="submit" disabled={registerStartInFlight}>
              {$t('header.createAccount')}
            </button>
          </form>
        {/if}
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
    background: rgba(8, 17, 31, 0.44);
    backdrop-filter: blur(8px);
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
    width: min(31rem, 100%);
    padding: 1rem;
    border: 1px solid var(--panel-border);
    border-radius: 1.3rem;
    background: color-mix(in srgb, var(--panel-solid) 88%, transparent);
    box-shadow: var(--shadow-panel);
    backdrop-filter: blur(18px);
    pointer-events: auto;
  }

  .auth-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.85rem;
  }

  .auth-head-copy {
    display: grid;
    gap: 0.2rem;
  }

  .auth-head h3 {
    margin: 0;
    color: var(--fg-strong);
  }

  .tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25rem;
    margin-bottom: 0.8rem;
  }

  .stack {
    display: grid;
    gap: 0.6rem;
    margin-bottom: 0.55rem;
  }

  .forgot-btn {
    border: 0;
    background: transparent;
    text-align: right;
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0;
  }

  .hint {
    margin: 0 0 0.15rem;
    color: var(--fg-strong);
    font-weight: 700;
    font-size: 0.92rem;
  }

  .status {
    margin: 0.4rem 0 0;
    padding: 0.75rem 0.85rem;
    border-radius: 1rem;
    border: 1px solid var(--panel-border);
    background: color-mix(in srgb, var(--panel-solid) 76%, transparent);
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }

  .consent {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    font-size: 0.82rem;
    color: var(--muted-strong);
  }

  .consent input {
    margin-top: 0.12rem;
  }

  .consent a {
    color: var(--accent-ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
