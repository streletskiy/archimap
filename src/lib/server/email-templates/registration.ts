const {
  ctaButtonStyle,
  codeLabelStyle,
  codeShellStyle,
  codeValueStyle,
  contentNoteStyle,
  contentParagraphStyle,
  emailShell,
  escapeHtml,
  linkStyle
} = require('./shell');
const {
  appendLocaleParam,
  getEmailCopy,
  normalizeEmailLocale
} = require('./localization');

function registrationCodeHtmlTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const safeCode = escapeHtml(String(code || '').trim());
  const safeMinutes = escapeHtml(expiresInMinutes);
  const safeConfirmUrl = escapeHtml(appendLocaleParam(confirmUrl, currentLocale));
  const appName = String(appDisplayName || '').trim() || 'archimap';

  return emailShell({
    lang: currentLocale,
    title: copy.registration.title,
    pretitle: copy.registration.pretitle,
    brandName: appName,
    intro: copy.registration.intro,
    contentHtml: `
      <div style="${codeShellStyle()}">
        <div style="${codeLabelStyle()}">${copy.registration.codeLabel}</div>
        <div style="${codeValueStyle()}">${safeCode}</div>
      </div>
      <p style="${contentParagraphStyle()}">${copy.registration.codeValidity(safeMinutes)}</p>
      <p style="margin:0 0 12px 0;">
        <a href="${safeConfirmUrl}" style="${ctaButtonStyle()}">${copy.registration.cta}</a>
      </p>
      <p style="${contentNoteStyle()}">${copy.registration.linkIntro} <a href="${safeConfirmUrl}" style="${linkStyle()}">${safeConfirmUrl}</a></p>
      <p style="${contentParagraphStyle('10px 0 0 0')}">${copy.registration.notRequested}</p>
    `,
    footer: copy.registration.footer
  });
}

function registrationCodeTextTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const appName = String(appDisplayName || '').trim() || 'archimap';
  return [
    `${appName}: ${copy.registration.subject}`,
    '',
    copy.registration.intro,
    '',
    `${copy.registration.textCodeLabel} ${String(code || '').trim()}`,
    copy.registration.codeValidity(expiresInMinutes),
    `${copy.registration.textLinkLabel} ${appendLocaleParam(confirmUrl, currentLocale)}`,
    '',
    copy.registration.notRequested
  ].join('\n');
}

module.exports = {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate
};
