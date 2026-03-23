const { sendMailWithFallback } = require('../smtp-transport.service');
const {
  registrationCodeHtmlTemplate: defaultRegistrationCodeHtmlTemplate,
  registrationCodeTextTemplate: defaultRegistrationCodeTextTemplate,
  passwordResetHtmlTemplate: defaultPasswordResetHtmlTemplate,
  passwordResetTextTemplate: defaultPasswordResetTextTemplate,
  smtpTestHtmlTemplate: defaultSmtpTestHtmlTemplate,
  smtpTestTextTemplate: defaultSmtpTestTextTemplate
} = require('../../email-templates');
const {
  appendLocaleParam,
  getEmailCopy,
  resolveEmailLocale
} = require('../../email-templates/localization');
const {
  createAdminError,
  isLikelyEmail,
  parseRegionId,
  parseLimit,
  resolveAppDisplayName,
  resolveAppBaseUrl
} = require('./shared');

function normalizeObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function createAdminSettingsService(options: LooseRecord = {}) {
  const {
    appSettingsService,
    dataSettingsService,
    getAllFilterTagKeysCached,
    applyFilterTagAllowlistSnapshot,
    onGeneralSettingsSaved,
    onSmtpSettingsSaved,
    onDataRegionsSaved,
    onRegionSyncRequested,
    onFilterPresetsSaved,
    registrationCodeHtmlTemplate = defaultRegistrationCodeHtmlTemplate,
    registrationCodeTextTemplate = defaultRegistrationCodeTextTemplate,
    passwordResetHtmlTemplate = defaultPasswordResetHtmlTemplate,
    passwordResetTextTemplate = defaultPasswordResetTextTemplate,
    smtpTestHtmlTemplate = defaultSmtpTestHtmlTemplate,
    smtpTestTextTemplate = defaultSmtpTestTextTemplate,
    registrationCodeTtlMinutes,
    passwordResetTtlMinutes
  } = options;

  function ensureAppSettingsService() {
    if (!appSettingsService) {
      throw createAdminError(500, 'Settings service is unavailable');
    }
    return appSettingsService;
  }

  function ensureDataSettingsService() {
    if (!dataSettingsService) {
      throw createAdminError(500, 'Data settings service is unavailable');
    }
    return dataSettingsService;
  }

  async function buildEmailPreviewPayload({ locale }: LooseRecord = {}) {
    const currentAppDisplayName = resolveAppDisplayName(options);
    const currentAppBaseUrl = resolveAppBaseUrl(options);
    const currentLocale = resolveEmailLocale({ locale });
    const copy = getEmailCopy(currentLocale);
    const generatedAt = new Date().toISOString();
    const sample = {
      registration: {
        code: '583401',
        expiresInMinutes: registrationCodeTtlMinutes,
        confirmUrl: appendLocaleParam(`${currentAppBaseUrl || 'https://archimap.local'}/account/?registerToken=sample-token-ui-preview`, currentLocale)
      },
      passwordReset: {
        expiresInMinutes: passwordResetTtlMinutes,
        resetUrl: appendLocaleParam(`${currentAppBaseUrl || 'https://archimap.local'}/?auth=1&reset=sample-reset-token`, currentLocale)
      },
      smtpTest: {
        testEmail: 'admin@example.test',
        sentAt: generatedAt,
        smtp: {
          host: 'smtp-relay.example.com',
          port: 587,
          secure: false,
          from: `${currentAppDisplayName} <no-reply@example.com>`
        }
      }
    };

    const registration = {
      subject: `${currentAppDisplayName}: ${copy.registration.subject}`,
      html: registrationCodeHtmlTemplate({
        code: sample.registration.code,
        expiresInMinutes: sample.registration.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        confirmUrl: sample.registration.confirmUrl,
        locale: currentLocale
      }),
      text: registrationCodeTextTemplate({
        code: sample.registration.code,
        expiresInMinutes: sample.registration.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        confirmUrl: sample.registration.confirmUrl,
        locale: currentLocale
      })
    };

    const passwordReset = {
      subject: `${currentAppDisplayName}: ${copy.passwordReset.subject}`,
      html: passwordResetHtmlTemplate({
        resetUrl: sample.passwordReset.resetUrl,
        expiresInMinutes: sample.passwordReset.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        locale: currentLocale
      }),
      text: passwordResetTextTemplate({
        resetUrl: sample.passwordReset.resetUrl,
        expiresInMinutes: sample.passwordReset.expiresInMinutes,
        appDisplayName: currentAppDisplayName,
        locale: currentLocale
      })
    };

    const smtpTest = {
      subject: `${currentAppDisplayName}: ${copy.smtpTest.subject}`,
      html: smtpTestHtmlTemplate({
        smtp: sample.smtpTest.smtp,
        testEmail: sample.smtpTest.testEmail,
        sentAt: sample.smtpTest.sentAt,
        appDisplayName: currentAppDisplayName,
        locale: currentLocale
      }),
      text: smtpTestTextTemplate({
        smtp: sample.smtpTest.smtp,
        testEmail: sample.smtpTest.testEmail,
        sentAt: sample.smtpTest.sentAt,
        appDisplayName: currentAppDisplayName,
        locale: currentLocale
      })
    };

    return {
      appDisplayName: currentAppDisplayName,
      generatedAt,
      templates: {
        registration,
        passwordReset,
        smtpTest
      }
    };
  }

  async function getSmtpSettingsItem() {
    return ensureAppSettingsService().getSmtpSettingsForAdmin();
  }

  async function getGeneralSettingsItem() {
    return ensureAppSettingsService().getGeneralSettingsForAdmin();
  }

  async function saveGeneralSettings(general, actor) {
    const saved = await ensureAppSettingsService().saveGeneralSettings(normalizeObject(general), actor);
    if (typeof onGeneralSettingsSaved === 'function') {
      onGeneralSettingsSaved(saved);
    }
    return saved;
  }

  async function saveSmtpSettings(smtp, actor) {
    const saved = await ensureAppSettingsService().saveSmtpSettings(normalizeObject(smtp), actor);
    if (typeof onSmtpSettingsSaved === 'function') {
      onSmtpSettingsSaved(saved);
    }
    return saved;
  }

  async function sendSmtpTest({ smtp, testEmail, locale }: LooseRecord = {}) {
    const effectiveTestEmail = String(testEmail || '').trim().toLowerCase();
    if (!isLikelyEmail(effectiveTestEmail)) {
      throw createAdminError(400, 'Provide a valid email for the test message');
    }

    const candidateInput = normalizeObject(smtp);
    const keepPassword = candidateInput.keepPassword !== false;
    const candidate = await ensureAppSettingsService().buildSmtpConfigFromInput(candidateInput, { keepPassword });
    if (!candidate.from) {
      throw createAdminError(400, 'SMTP test requires a From address');
    }

    const effectiveAppDisplayName = resolveAppDisplayName(options);
    const currentLocale = resolveEmailLocale({ locale });
    const copy = getEmailCopy(currentLocale);
    const subject = `${effectiveAppDisplayName}: ${copy.smtpTest.subject}`;
    const sentAt = new Date().toISOString();
    const text = smtpTestTextTemplate({
      smtp: candidate,
      testEmail: effectiveTestEmail,
      sentAt,
      appDisplayName: effectiveAppDisplayName,
      locale: currentLocale
    });
    const html = smtpTestHtmlTemplate({
      smtp: candidate,
      testEmail: effectiveTestEmail,
      sentAt,
      appDisplayName: effectiveAppDisplayName,
      locale: currentLocale
    });

    if (!candidate.url && (!candidate.host || !candidate.port || !candidate.user || !candidate.pass || !candidate.from)) {
      throw createAdminError(400, 'SMTP test requires host/port/user/password/from or smtp url');
    }

    try {
      await sendMailWithFallback(candidate, {
        from: candidate.from,
        to: effectiveTestEmail,
        subject,
        text,
        html
      }, {
        logContext: { flow: 'admin_smtp_test', to: '[REDACTED]' }
      });
    } catch (error) {
      throw createAdminError(400, `SMTP test send failed: ${String(error?.message || error)}`);
    }

    return {
      ok: true,
      message: `Test email sent to ${effectiveTestEmail}`
    };
  }

  async function getDataSettingsItem() {
    const base = await ensureDataSettingsService().getDataSettingsForAdmin();
    const availableKeys = typeof getAllFilterTagKeysCached === 'function'
      ? await getAllFilterTagKeysCached()
      : [];
    return {
      ...base,
      filterTags: {
        ...(base.filterTags || {}),
        availableKeys
      }
    };
  }

  async function saveFilterTagAllowlist(allowlist, actor) {
    try {
      const values = Array.isArray(allowlist) ? allowlist : [];
      const saved = await ensureDataSettingsService().saveFilterTagAllowlist(values, actor);
      if (typeof applyFilterTagAllowlistSnapshot === 'function') {
        applyFilterTagAllowlistSnapshot(saved);
      }
      return saved;
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to save filter tag allowlist'));
    }
  }

  async function listFilterPresets() {
    try {
      return ensureDataSettingsService().getFilterPresetsForAdmin();
    } catch (error) {
      if (error?.status) throw error;
      throw createAdminError(400, String(error?.message || error || 'Failed to load filter presets'));
    }
  }

  async function saveFilterPreset(preset, actor) {
    try {
      const saved = await ensureDataSettingsService().saveFilterPreset(normalizeObject(preset), actor);
      if (typeof onFilterPresetsSaved === 'function') {
        await Promise.resolve(onFilterPresetsSaved({
          action: 'save',
          saved
        }));
      }
      return saved;
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to save filter preset'));
    }
  }

  async function deleteFilterPreset(id) {
    try {
      const deleted = await ensureDataSettingsService().deleteFilterPresetById(id);
      if (typeof onFilterPresetsSaved === 'function') {
        await Promise.resolve(onFilterPresetsSaved({
          action: 'delete',
          deleted
        }));
      }
      return deleted;
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to delete filter preset'));
    }
  }

  async function listRegions(includeDisabledRaw) {
    const includeDisabled = String(includeDisabledRaw ?? 'true').trim().toLowerCase() !== 'false';
    return ensureDataSettingsService().listRegions({
      includeDisabled,
      includeStorageStats: true
    });
  }

  async function resolveExtractCandidates({ query, source }: LooseRecord = {}) {
    try {
      const resolved = await ensureDataSettingsService().searchExtractCandidates(String(query || '').trim(), {
        source: String(source || 'any').trim() || 'any',
        limit: 12
      });
      return {
        query: resolved.query,
        items: resolved.items
      };
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to resolve extract candidates'));
    }
  }

  async function getRegionRuns(regionIdRaw, limitRaw) {
    const service = ensureDataSettingsService();
    const regionId = parseRegionId(regionIdRaw);
    if (!regionId) {
      throw createAdminError(400, 'Invalid region id');
    }
    const limit = parseLimit(limitRaw, 20, 1, 200);
    const region = await service.getRegionById(regionId);
    if (!region) {
      throw createAdminError(404, 'Region not found');
    }
    const items = await service.getRecentRuns(regionId, limit);
    return {
      region,
      items
    };
  }

  async function saveRegion(region, actor) {
    try {
      const service = ensureDataSettingsService();
      const candidate = normalizeObject(region);
      const previous = candidate?.id ? await service.getRegionById(candidate.id) : null;
      const saved = await service.saveRegion(candidate, actor);
      if (typeof onDataRegionsSaved === 'function') {
        await Promise.resolve(onDataRegionsSaved({
          action: 'save',
          saved,
          previous
        }));
      }
      return saved;
    } catch (error) {
      if (error?.status) {
        throw error;
      }
      throw createAdminError(400, String(error?.message || error || 'Failed to save region'));
    }
  }

  async function deleteRegion(regionIdRaw, actor) {
    const service = ensureDataSettingsService();
    const regionId = parseRegionId(regionIdRaw);
    if (!regionId) {
      throw createAdminError(400, 'Invalid region id');
    }

    try {
      const deleted = await service.deleteRegion(regionId, actor);
      if (typeof onDataRegionsSaved === 'function') {
        await Promise.resolve(onDataRegionsSaved({
          action: 'delete',
          deleted
        }));
      }
      return deleted;
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to delete region'));
    }
  }

  async function requestRegionSync(regionIdRaw, requestedBy) {
    ensureDataSettingsService();
    if (typeof onRegionSyncRequested !== 'function') {
      throw createAdminError(503, 'Sync queue is currently unavailable');
    }
    const regionId = parseRegionId(regionIdRaw);
    if (!regionId) {
      throw createAdminError(400, 'Invalid region id');
    }

    try {
      return await onRegionSyncRequested(regionId, {
        triggerReason: 'manual',
        requestedBy
      });
    } catch (error) {
      throw createAdminError(400, String(error?.message || error || 'Failed to queue region sync'));
    }
  }

  return {
    buildEmailPreviewPayload,
    getSmtpSettingsItem,
    getGeneralSettingsItem,
    saveGeneralSettings,
    saveSmtpSettings,
    sendSmtpTest,
    getDataSettingsItem,
    saveFilterTagAllowlist,
    listFilterPresets,
    saveFilterPreset,
    deleteFilterPreset,
    listRegions,
    resolveExtractCandidates,
    getRegionRuns,
    saveRegion,
    deleteRegion,
    requestRegionSync
  };
}

module.exports = {
  createAdminSettingsService
};
