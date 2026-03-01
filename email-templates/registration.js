const { escapeHtml, emailShell } = require('./shell');

function registrationCodeHtmlTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }) {
  const safeCode = escapeHtml(String(code || '').trim());
  const safeMinutes = escapeHtml(expiresInMinutes);
  const safeConfirmUrl = escapeHtml(confirmUrl);
  const appName = String(appDisplayName || '').trim() || 'archimap';
  const safeAppName = escapeHtml(appName);

  return emailShell({
    title: 'Подтверждение регистрации',
    pretitle: safeAppName || 'archimap',
    intro: 'Используйте код ниже, чтобы завершить создание аккаунта.',
    contentHtml: `
      <div style="margin:0 auto 16px auto;max-width:340px;border:1px dashed #cbd5e1;border-radius:16px;background:#f8fafc;padding:14px 16px;text-align:center;">
        <div style="font-size:13px;color:#64748b;margin:0 0 8px 0;">Код подтверждения</div>
        <div style="font-size:38px;letter-spacing:8px;line-height:1;font-weight:800;color:#4338ca;">${safeCode}</div>
      </div>
      <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#334155;">Код действует <strong>${safeMinutes} минут</strong>.</p>
      <p style="margin:0 0 12px 0;">
        <a href="${safeConfirmUrl}" style="display:inline-block;padding:11px 16px;border-radius:10px;background:#5b62f0;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Подтвердить регистрацию</a>
      </p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">Если кнопка не работает, откройте ссылку: ${safeConfirmUrl}</p>
      <p style="margin:10px 0 0 0;font-size:14px;line-height:1.7;color:#334155;">Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.</p>
    `,
    footer: 'Это автоматическое письмо. Отвечать на него не нужно.'
  });
}

function registrationCodeTextTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }) {
  const appName = String(appDisplayName || '').trim() || 'archimap';
  return [
    `${appName}: код подтверждения регистрации`,
    '',
    `Ваш код: ${String(code || '').trim()}`,
    `Код действителен ${expiresInMinutes} минут.`,
    `Подтверждение по ссылке: ${confirmUrl}`,
    '',
    'Если вы не запрашивали регистрацию, проигнорируйте это письмо.'
  ].join('\n');
}

module.exports = {
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate
};
