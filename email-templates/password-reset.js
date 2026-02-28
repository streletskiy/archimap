const { escapeHtml, emailShell } = require('./shell');

function passwordResetHtmlTemplate({ resetUrl, expiresInMinutes, appDisplayName }) {
  const safeResetUrl = escapeHtml(resetUrl);
  const safeMinutes = escapeHtml(expiresInMinutes);
  const safeAppName = escapeHtml(appDisplayName);

  return emailShell({
    title: 'Сброс пароля',
    pretitle: safeAppName || 'ArchiMap',
    intro: 'Нажмите кнопку ниже, чтобы задать новый пароль.',
    contentHtml: `
      <p style="margin:0 0 12px 0;">
        <a href="${safeResetUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#5b62f0;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Сбросить пароль</a>
      </p>
      <p style="margin:0;font-size:14px;line-height:1.7;color:#334155;">Ссылка действует <strong>${safeMinutes} минут</strong>.</p>
      <p style="margin:8px 0 0 0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">Если кнопка не работает, откройте ссылку: ${safeResetUrl}</p>
      <p style="margin:10px 0 0 0;font-size:14px;line-height:1.7;color:#334155;">Если вы не запрашивали сброс пароля, просто проигнорируйте письмо.</p>
    `,
    footer: 'Это автоматическое письмо. Отвечать на него не нужно.'
  });
}

function passwordResetTextTemplate({ resetUrl, expiresInMinutes, appDisplayName }) {
  return [
    `${appDisplayName}: сброс пароля`,
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
