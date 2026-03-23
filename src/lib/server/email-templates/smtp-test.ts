const {
  EMAIL_THEME,
  contentNoteStyle,
  contentParagraphStyle,
  emailShell,
  escapeHtml
} = require('./shell');

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

function buildTransportLabel(smtp) {
  return String(smtp?.url || '').trim() ? 'SMTP URL' : 'Host / Port';
}

function buildTransportValue(smtp) {
  if (String(smtp?.url || '').trim()) {
    return 'Конфигурация передана через SMTP URL';
  }
  const host = String(smtp?.host || '').trim() || 'не указан';
  const port = String(smtp?.port || '').trim() || 'не указан';
  return `${host}:${port}`;
}

function buildDetailRows({ smtp = {}, testEmail = '', sentAt = '' }) {
  const rows = [
    ['Дата', sentAt || new Date().toISOString()],
    ['Кому', testEmail || 'не указан'],
    ['От кого', String(smtp?.from || smtp?.user || '').trim() || 'не указан'],
    ['Транспорт', buildTransportLabel(smtp)],
    ['Параметры', buildTransportValue(smtp)],
    ['Secure', smtp?.secure ? 'true' : 'false']
  ];

  return rows;
}

function smtpTestHtmlTemplate({ smtp, testEmail, sentAt, appDisplayName }) {
  const appName = String(appDisplayName || '').trim() || 'archimap';
  const safeDetails = buildDetailRows({ smtp, testEmail, sentAt })
    .map(([label, value], index) => renderDetailRow(label, value, index === 0))
    .join('');
  const safeEmail = escapeHtml(String(testEmail || '').trim() || 'не указан');

  return emailShell({
    title: 'Тест отправки почты',
    pretitle: 'Проверка',
    brandName: appName,
    intro: 'Это тестовое письмо подтверждает, что исходящая почта ArchiMap работает.',
    contentHtml: `
      <div style="${detailCalloutStyle()}">
        <p style="${detailCalloutTextStyle()}">Если вы видите это письмо, SMTP доставка настроена корректно для адреса ${safeEmail}.</p>
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="${detailTableStyle()}">
        ${safeDetails}
      </table>
      <p style="${contentParagraphStyle('16px 0 0 0')}">Письмо отправлено из админки для проверки SMTP настроек.</p>
      <p style="${contentNoteStyle('8px 0 0 0')}">Если вы не запускали тест, это письмо можно проигнорировать.</p>
    `,
    footer: 'Это автоматическое диагностическое письмо. Отвечать на него не нужно.'
  });
}

function smtpTestTextTemplate({ smtp, testEmail, sentAt, appDisplayName }) {
  const appName = String(appDisplayName || '').trim() || 'archimap';
  const rows = buildDetailRows({ smtp, testEmail, sentAt }).map(([label, value]) => `${label}: ${value}`);
  return [
    `${appName}: тест отправки почты`,
    '',
    'Это тестовое письмо подтверждает, что исходящая почта ArchiMap работает.',
    '',
    ...rows,
    '',
    'Письмо отправлено из админки для проверки SMTP настроек.',
    'Если вы не запускали тест, просто проигнорируйте письмо.'
  ].join('\n');
}

module.exports = {
  smtpTestHtmlTemplate,
  smtpTestTextTemplate
};
