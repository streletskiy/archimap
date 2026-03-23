const {
  ctaButtonStyle,
  contentNoteStyle,
  contentParagraphStyle,
  emailShell,
  escapeHtml,
  linkStyle
} = require('./shell');

function passwordResetHtmlTemplate({ resetUrl, expiresInMinutes, appDisplayName }) {
  const safeResetUrl = escapeHtml(resetUrl);
  const safeMinutes = escapeHtml(expiresInMinutes);
  const appName = String(appDisplayName || '').trim() || 'archimap';

  return emailShell({
    title: 'Сброс пароля',
    pretitle: 'Восстановление',
    brandName: appName,
    intro: 'Нажмите кнопку ниже, чтобы задать новый пароль.',
    contentHtml: `
      <p style="margin:0 0 12px 0;">
        <a href="${safeResetUrl}" style="${ctaButtonStyle()}">Сбросить пароль</a>
      </p>
      <p style="${contentParagraphStyle()}">Ссылка действует <strong>${safeMinutes} минут</strong>.</p>
      <p style="${contentNoteStyle()}">Если кнопка не работает, откройте ссылку: <a href="${safeResetUrl}" style="${linkStyle()}">${safeResetUrl}</a></p>
      <p style="${contentParagraphStyle('10px 0 0 0')}">Если вы не запрашивали сброс пароля, просто проигнорируйте письмо.</p>
    `,
    footer: 'Это автоматическое письмо. Отвечать на него не нужно.'
  });
}

function passwordResetTextTemplate({ resetUrl, expiresInMinutes, appDisplayName }) {
  const appName = String(appDisplayName || '').trim() || 'archimap';
  return [
    `${appName}: сброс пароля`,
    '',
    `Откройте ссылку, чтобы задать новый пароль: ${resetUrl}`,
    `Ссылка действительна ${expiresInMinutes} минут.`,
    '',
    'Если вы не запрашивали сброс пароля, проигнорируйте письмо.'
  ].join('\n');
}

module.exports = {
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
};
