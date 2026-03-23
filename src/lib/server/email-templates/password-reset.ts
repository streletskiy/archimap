const {
  ctaButtonStyle,
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

function passwordResetHtmlTemplate({ resetUrl, expiresInMinutes, appDisplayName, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const safeResetUrl = escapeHtml(appendLocaleParam(resetUrl, currentLocale));
  const safeMinutes = escapeHtml(expiresInMinutes);
  const appName = String(appDisplayName || '').trim() || 'archimap';

  return emailShell({
    lang: currentLocale,
    title: copy.passwordReset.title,
    pretitle: copy.passwordReset.pretitle,
    brandName: appName,
    intro: copy.passwordReset.intro,
    contentHtml: `
      <p style="margin:0 0 12px 0;">
        <a href="${safeResetUrl}" style="${ctaButtonStyle()}">${copy.passwordReset.cta}</a>
      </p>
      <p style="${contentParagraphStyle()}">${copy.passwordReset.validity(safeMinutes)}</p>
      <p style="${contentNoteStyle()}">${copy.passwordReset.linkIntro} <a href="${safeResetUrl}" style="${linkStyle()}">${safeResetUrl}</a></p>
      <p style="${contentParagraphStyle('10px 0 0 0')}">${copy.passwordReset.notRequested}</p>
    `,
    footer: copy.passwordReset.footer
  });
}

function passwordResetTextTemplate({ resetUrl, expiresInMinutes, appDisplayName, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const appName = String(appDisplayName || '').trim() || 'archimap';
  return [
    `${appName}: ${copy.passwordReset.subject}`,
    '',
    copy.passwordReset.intro,
    `${copy.passwordReset.textLinkLabel} ${appendLocaleParam(resetUrl, currentLocale)}`,
    copy.passwordReset.validity(expiresInMinutes),
    '',
    copy.passwordReset.notRequested
  ].join('\n');
}

module.exports = {
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
};
