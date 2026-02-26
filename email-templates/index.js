function registrationCodeHtmlTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }) {
  return `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Код подтверждения</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;background:#f8fafc;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#eff6ff 0%,#ecfeff 100%);padding:28px 28px 18px 28px;">
              <div style="display:inline-block;padding:6px 12px;background:#ffffff;border:1px solid #dbeafe;border-radius:999px;color:#0369a1;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;">${appDisplayName}</div>
              <h1 style="margin:14px 0 0 0;font-size:24px;line-height:1.25;color:#0f172a;">Подтверждение регистрации</h1>
              <p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#334155;">Используйте код ниже, чтобы завершить создание аккаунта.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 28px;">
              <div style="margin:0 auto 18px auto;max-width:320px;border:1px dashed #cbd5e1;border-radius:16px;background:#f8fafc;padding:14px 16px;text-align:center;">
                <div style="font-size:13px;color:#64748b;margin:0 0 8px 0;">Код подтверждения</div>
                <div style="font-size:38px;letter-spacing:8px;line-height:1;font-weight:800;color:#0369a1;">${String(code || '').trim()}</div>
              </div>
              <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#334155;">Код действует <strong>${expiresInMinutes} минут</strong>.</p>
              <p style="margin:0 0 12px 0;">
                <a href="${confirmUrl}" style="display:inline-block;padding:11px 16px;border-radius:10px;background:#0284c7;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Подтвердить регистрацию</a>
              </p>
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">Если кнопка не работает, откройте ссылку: ${confirmUrl}</p>
              <p style="margin:10px 0 0 0;font-size:14px;line-height:1.7;color:#334155;">Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 24px 28px;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">Это автоматическое письмо. Отвечать на него не нужно.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function registrationCodeTextTemplate({ code, expiresInMinutes, appDisplayName, confirmUrl }) {
  return [
    `${appDisplayName}: код подтверждения регистрации`,
    '',
    `Ваш код: ${String(code || '').trim()}`,
    `Код действителен ${expiresInMinutes} минут.`,
    `Подтверждение по ссылке: ${confirmUrl}`,
    '',
    'Если вы не запрашивали регистрацию, проигнорируйте это письмо.'
  ].join('\n');
}

function passwordResetHtmlTemplate({ resetUrl, expiresInMinutes, appDisplayName }) {
  return `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Сброс пароля</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;background:#f8fafc;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#ecfeff 0%,#eff6ff 100%);padding:28px 28px 18px 28px;">
              <div style="display:inline-block;padding:6px 12px;background:#ffffff;border:1px solid #dbeafe;border-radius:999px;color:#0369a1;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;">${appDisplayName}</div>
              <h1 style="margin:14px 0 0 0;font-size:24px;line-height:1.25;color:#0f172a;">Сброс пароля</h1>
              <p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#334155;">Нажмите кнопку ниже, чтобы задать новый пароль.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 28px;">
              <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0ea5e9;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Сбросить пароль</a>
              <p style="margin:14px 0 0 0;font-size:14px;line-height:1.7;color:#334155;">Ссылка действует <strong>${expiresInMinutes} минут</strong>.</p>
              <p style="margin:8px 0 0 0;font-size:12px;line-height:1.6;color:#64748b;word-break:break-all;">Если кнопка не работает, откройте ссылку: ${resetUrl}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 24px 28px;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">Если вы не запрашивали сброс пароля, просто проигнорируйте письмо.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
  registrationCodeHtmlTemplate,
  registrationCodeTextTemplate,
  passwordResetHtmlTemplate,
  passwordResetTextTemplate
};
