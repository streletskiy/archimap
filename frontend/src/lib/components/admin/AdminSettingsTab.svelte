<script>
  import { onMount } from 'svelte';

  import { UiButton, UiCheckbox, UiInput, UiSelect } from '$lib/components/base';
  import { t, translateNow } from '$lib/i18n/index';
  import { apiJson } from '$lib/services/http';

  export let isMasterAdmin = false;

  const msg = (error, fallback) => String(error?.message || fallback);

  let general = {
    appDisplayName: 'archimap',
    appBaseUrl: '',
    registrationEnabled: true,
    userEditRequiresPermission: true,
    metricsToken: '',
    basemapProvider: 'carto',
    maptilerApiKey: ''
  };
  let generalLoading = false;
  let generalStatus = '';
  let basemapProviderItems = [];

  let smtp = {
    url: '',
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
    hasPassword: false
  };
  let smtpLoading = false;
  let smtpStatus = '';
  let smtpTestEmail = '';

  async function loadGeneral() {
    generalLoading = true;
    generalStatus = translateNow('admin.loading');

    try {
      const data = await apiJson('/api/admin/app-settings/general');
      general = data?.item?.general || general;
      generalStatus = '';
    } catch (error) {
      generalStatus = msg(error, translateNow('admin.settings.loadGeneralFailed'));
    } finally {
      generalLoading = false;
    }
  }

  async function saveGeneral(event) {
    event.preventDefault();
    if (general.basemapProvider === 'maptiler' && String(general.maptilerApiKey || '').trim() === '') {
      generalStatus = translateNow('admin.settings.maptilerApiKeyRequired');
      return;
    }
    generalLoading = true;
    generalStatus = translateNow('admin.settings.saving');

    try {
      const data = await apiJson('/api/admin/app-settings/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ general })
      });
      general = data?.item?.general || general;
      if (typeof window !== 'undefined') {
        window.__ARCHIMAP_CONFIG = window.__ARCHIMAP_CONFIG || {};
        window.__ARCHIMAP_CONFIG.basemap = {
          provider: general.basemapProvider,
          maptilerApiKey: general.maptilerApiKey
        };
      }
      generalStatus = translateNow('admin.settings.saved');
    } catch (error) {
      generalStatus = msg(error, translateNow('admin.settings.saveGeneralFailed'));
    } finally {
      generalLoading = false;
    }
  }

  $: basemapProviderItems = [
    {
      value: 'carto',
      label: $t('admin.settings.basemapProviderCarto')
    },
    {
      value: 'maptiler',
      label: $t('admin.settings.basemapProviderMaptiler')
    }
  ];

  async function loadSmtp() {
    smtpLoading = true;
    smtpStatus = translateNow('admin.loading');

    try {
      const data = await apiJson('/api/admin/app-settings/smtp');
      const value = data?.item?.smtp || {};
      smtp = {
        url: String(value.url || ''),
        host: String(value.host || ''),
        port: Number(value.port || 587),
        secure: Boolean(value.secure),
        user: String(value.user || ''),
        pass: '',
        from: String(value.from || ''),
        hasPassword: Boolean(value.hasPassword)
      };
      smtpStatus = '';
    } catch (error) {
      smtpStatus = msg(error, translateNow('admin.settings.loadSmtpFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  async function saveSmtp(event) {
    event.preventDefault();
    smtpLoading = true;
    smtpStatus = translateNow('admin.settings.saving');

    try {
      await apiJson('/api/admin/app-settings/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtp: { ...smtp, keepPassword: String(smtp.pass || '').trim() === '' } })
      });
      smtp.pass = '';
      smtpStatus = translateNow('admin.settings.smtpSaved');
    } catch (error) {
      smtpStatus = msg(error, translateNow('admin.settings.saveSmtpFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  async function testSmtp() {
    smtpLoading = true;
    smtpStatus = translateNow('admin.settings.smtpTesting');

    try {
      const data = await apiJson('/api/admin/app-settings/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testEmail: smtpTestEmail,
          smtp: { ...smtp, keepPassword: String(smtp.pass || '').trim() === '' }
        })
      });
      smtpStatus = String(data?.message || translateNow('admin.settings.smtpTestSent'));
    } catch (error) {
      smtpStatus = msg(error, translateNow('admin.settings.smtpTestFailed'));
    } finally {
      smtpLoading = false;
    }
  }

  onMount(() => {
    if (!isMasterAdmin) return;
    void loadGeneral();
    void loadSmtp();
  });
</script>

{#if !isMasterAdmin}
  <p class="mt-3 text-sm ui-text-muted">{$t('admin.settings.masterOnly')}</p>
{:else}
  <div class="mt-3 grid gap-4 lg:grid-cols-2">
    <form class="space-y-2 rounded-2xl border ui-border ui-surface-muted p-4" on:submit={saveGeneral}>
      <h3 class="text-base font-bold ui-text-strong">{$t('admin.settings.generalTitle')}</h3>
      <UiInput bind:value={general.appDisplayName} placeholder={$t('admin.settings.appNamePlaceholder')} />
      <UiInput bind:value={general.appBaseUrl} placeholder={$t('admin.settings.baseUrlPlaceholder')} />
      <label class="flex items-center gap-2 text-sm ui-text-body"
        ><UiCheckbox bind:checked={general.registrationEnabled} />
        {$t('admin.settings.registrationEnabled')}</label
      >
      <label class="flex items-center gap-2 text-sm ui-text-body"
        ><UiCheckbox bind:checked={general.userEditRequiresPermission} />
        {$t('admin.settings.editRequiresPermission')}</label
      >
      <div class="space-y-1">
        <div class="text-sm font-semibold text-gray-700">{$t('admin.settings.basemapTitle')}</div>
        <UiSelect
          items={basemapProviderItems}
          bind:value={general.basemapProvider}
          placeholder={$t('admin.settings.basemapTitle')}
        />
      </div>
      <div class="space-y-1">
        <div class="text-sm font-semibold text-gray-700">{$t('admin.settings.maptilerApiKey')}</div>
        <UiInput
          type="password"
          bind:value={general.maptilerApiKey}
          placeholder={$t('admin.settings.maptilerApiKeyPlaceholder')}
          disabled={general.basemapProvider !== 'maptiler'}
        />
        <p class="text-xs ui-text-muted">{$t('admin.settings.basemapHelp')}</p>
      </div>
      <div class="mt-2 text-sm text-gray-500">
        <div class="font-semibold text-gray-700">{$t('admin.settings.metricsToken')}:</div>
        <div class="flex items-center gap-2 mt-1">
          <UiInput type="text" className="flex-1 font-mono text-xs" readonly value={general.metricsToken || $t('admin.settings.metricsTokenGenerating')} />
          <UiButton type="button" variant="secondary" onclick={() => { general.metricsToken = ''; saveGeneral({preventDefault: () => {}}); }}>{$t('admin.settings.metricsTokenRegenerate')}</UiButton>
        </div>
      </div>
      <UiButton type="submit" className="mt-4" disabled={generalLoading}>{$t('common.save')}</UiButton>
      {#if generalStatus}
        <p class="text-sm ui-text-muted">{generalStatus}</p>
      {/if}
    </form>

    <form class="space-y-2 rounded-2xl border ui-border ui-surface-muted p-4" on:submit={saveSmtp}>
      <h3 class="text-base font-bold ui-text-strong">{$t('admin.settings.smtpTitle')}</h3>
      <UiInput bind:value={smtp.url} placeholder={$t('admin.settings.smtpUrl')} />
      <div class="grid gap-2 sm:grid-cols-2">
        <UiInput bind:value={smtp.host} placeholder={$t('admin.settings.host')} />
        <UiInput type="number" min="1" max="65535" bind:value={smtp.port} placeholder={$t('admin.settings.port')} />
      </div>
      <UiInput bind:value={smtp.user} placeholder={$t('admin.settings.user')} />
      <UiInput
        type="password"
        bind:value={smtp.pass}
        placeholder={smtp.hasPassword ? $t('admin.settings.passwordKeep') : $t('admin.settings.password')}
      />
      <UiInput bind:value={smtp.from} placeholder={$t('admin.settings.from')} />
      <label class="flex items-center gap-2 text-sm ui-text-body"
        ><UiCheckbox bind:checked={smtp.secure} /> {$t('admin.settings.secure')}</label
      >
      <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <UiInput type="email" bind:value={smtpTestEmail} placeholder={$t('admin.settings.testEmail')} />
        <UiButton type="button" variant="secondary" onclick={testSmtp} disabled={smtpLoading}
          >{$t('admin.settings.smtpTest')}</UiButton
        >
        <UiButton type="submit" disabled={smtpLoading}>{$t('admin.settings.smtpSave')}</UiButton>
      </div>
      {#if smtpStatus}
        <p class="text-sm ui-text-muted">{smtpStatus}</p>
      {/if}
    </form>
  </div>
{/if}
