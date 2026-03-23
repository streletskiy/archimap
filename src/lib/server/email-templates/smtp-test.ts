const {
  EMAIL_THEME,
  contentNoteStyle,
  contentParagraphStyle,
  emailShell,
  escapeHtml
} = require('./shell');
const {
  formatEmailDate,
  getEmailCopy,
  normalizeEmailLocale
} = require('./localization');

const DETAIL_BORDER = EMAIL_THEME.cardBorder;
const DETAIL_LABEL_COLOR = EMAIL_THEME.textMuted;
const DETAIL_VALUE_COLOR = EMAIL_THEME.textMutedStrong;
const DETAIL_BG = EMAIL_THEME.cardBackground;
const ACCENT_BORDER = 'rgba(253, 200, 47, 0.26)';
const ACCENT_BG = 'rgba(253, 200, 47, 0.12)';

function rowLabelStyle(firstRow = false) {
  return `padding:12px 14px 12px 0;border-top:${firstRow ? '0' : `1px solid ${DETAIL_BORDER}`};color:${DETAIL_LABEL_COLOR};font-size:11px;line-height:1.35;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;vertical-align:top;width:34%;`;
}

function rowValueStyle(firstRow = false) {
  return `padding:12px 0;border-top:${firstRow ? '0' : `1px solid ${DETAIL_BORDER}`};color:${DETAIL_VALUE_COLOR};font-size:14px;line-height:1.6;vertical-align:top;word-break:break-word;`;
}

function detailTableStyle() {
  return `width:100%;border:1px solid ${DETAIL_BORDER};border-radius:18px;background:${DETAIL_BG};overflow:hidden;border-collapse:separate;border-spacing:0;`;
}

function detailCalloutStyle() {
  return `margin:0 0 18px 0;padding:16px 18px;border:1px solid ${ACCENT_BORDER};border-radius:18px;background:${ACCENT_BG};`;
}

function detailCalloutTextStyle() {
  return `margin:0;font-size:14px;line-height:1.65;color:${DETAIL_VALUE_COLOR};font-weight:600;`;
}

function renderDetailRow(label, value, firstRow = false) {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value);
  return `
    <tr>
      <td style="${rowLabelStyle(firstRow)}">${safeLabel}</td>
      <td style="${rowValueStyle(firstRow)}">${safeValue}</td>
    </tr>
  `;
}

function buildTransportLabel(smtp, copy) {
  return String(smtp?.url || '').trim() ? copy.smtpTest.transportUrlLabel : copy.smtpTest.transportHostPortLabel;
}

function buildTransportValue(smtp, copy) {
  if (String(smtp?.url || '').trim()) {
    return copy.smtpTest.transportUrlValue;
  }
  const host = String(smtp?.host || '').trim() || copy.smtpTest.notProvided;
  const port = String(smtp?.port || '').trim() || copy.smtpTest.notProvided;
  return `${host}:${port}`;
}

function buildDetailRows({ smtp = {}, testEmail = '', sentAt = '', locale }: LooseRecord = {}) {
  const copy = getEmailCopy(locale);
  const rows = [
    [copy.smtpTest.detailLabels.date, formatEmailDate(sentAt, locale)],
    [copy.smtpTest.detailLabels.to, testEmail || copy.smtpTest.notProvided],
    [copy.smtpTest.detailLabels.from, String(smtp?.from || smtp?.user || '').trim() || copy.smtpTest.notProvided],
    [copy.smtpTest.detailLabels.transport, buildTransportLabel(smtp, copy)],
    [copy.smtpTest.detailLabels.parameters, buildTransportValue(smtp, copy)],
    [copy.smtpTest.detailLabels.secure, smtp?.secure ? copy.smtpTest.yes : copy.smtpTest.no]
  ];

  return rows;
}

function smtpTestHtmlTemplate({ smtp, testEmail, sentAt, appDisplayName, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const appName = String(appDisplayName || '').trim() || 'archimap';
  const safeDetails = buildDetailRows({ smtp, testEmail, sentAt, locale: currentLocale })
    .map(([label, value], index) => renderDetailRow(label, value, index === 0))
    .join('');
  const safeEmail = escapeHtml(String(testEmail || '').trim() || copy.smtpTest.notProvided);

  return emailShell({
    lang: currentLocale,
    title: copy.smtpTest.title,
    pretitle: copy.smtpTest.pretitle,
    brandName: appName,
    intro: copy.smtpTest.intro,
    contentHtml: `
      <div style="${detailCalloutStyle()}">
        <p style="${detailCalloutTextStyle()}">${copy.smtpTest.callout(safeEmail)}</p>
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="${detailTableStyle()}">
        ${safeDetails}
      </table>
      <p style="${contentParagraphStyle('16px 0 0 0')}">${copy.smtpTest.note}</p>
      <p style="${contentNoteStyle('8px 0 0 0')}">${copy.smtpTest.ignore}</p>
    `,
    footer: copy.smtpTest.footer
  });
}

function smtpTestTextTemplate({ smtp, testEmail, sentAt, appDisplayName, locale }) {
  const currentLocale = normalizeEmailLocale(locale);
  const copy = getEmailCopy(currentLocale);
  const appName = String(appDisplayName || '').trim() || 'archimap';
  const rows = buildDetailRows({ smtp, testEmail, sentAt, locale: currentLocale }).map(([label, value]) => `${label}: ${value}`);
  return [
    `${appName}: ${copy.smtpTest.subject}`,
    '',
    copy.smtpTest.intro,
    '',
    ...rows,
    '',
    copy.smtpTest.note,
    copy.smtpTest.ignore
  ].join('\n');
}

module.exports = {
  smtpTestHtmlTemplate,
  smtpTestTextTemplate
};
