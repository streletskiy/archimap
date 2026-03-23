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

function registrationCodeHtmlTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }) {
  const safeCode = escapeHtml(String(code || '').trim());
  const safeMinutes = escapeHtml(expiresInMinutes);
  const safeConfirmUrl = escapeHtml(confirmUrl);
  const appName = String(appDisplayName || '').trim() || 'archimap';

  return emailShell({
    title: 'Подтверждение регистрации',
    pretitle: 'Регистрация',
    brandName: appName,
    intro: 'Используйте код ниже, чтобы завершить создание аккаунта.',
    contentHtml: `
      <div style="${codeShellStyle()}">
        <div style="${codeLabelStyle()}">Код подтверждения</div>
        <div style="${codeValueStyle()}">${safeCode}</div>
      </div>
      <p style="${contentParagraphStyle()}">Код действует <strong>${safeMinutes} минут</strong>.</p>
      <p style="margin:0 0 12px 0;">
        <a href="${safeConfirmUrl}" style="${ctaButtonStyle()}">Подтвердить регистрацию</a>
      </p>
      <p style="${contentNoteStyle()}">Если кнопка не работает, откройте ссылку: <a href="${safeConfirmUrl}" style="${linkStyle()}">${safeConfirmUrl}</a></p>
      <p style="${contentParagraphStyle('10px 0 0 0')}">Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.</p>
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
