const { normalizeEmailLocale } = require('./localization');

const EMAIL_THEME = {
  pageTop: '#f6f4ef',
  pageBottom: '#f1efea',
  cardBackground: '#fbfaf7',
  cardBorder: 'rgba(120, 113, 105, 0.22)',
  cardBorderStrong: 'rgba(67, 63, 57, 0.28)',
  text: '#1d1b19',
  textStrong: '#11100f',
  textMuted: '#6d6861',
  textMutedStrong: '#433f39',
  accent: '#fdc82f',
  accentSoft: 'rgba(253, 200, 47, 0.16)',
  accentBrass: '#e2af14',
  accentInk: '#5b4300',
  accentContrast: '#342700',
  shadow: '0 18px 44px rgba(15, 23, 42, 0.12)',
  fontBody: "'Aptos', 'Segoe UI Variable Text', 'Segoe UI', Arial, sans-serif",
  fontDisplay: "'Bahnschrift', 'Aptos', 'Segoe UI', Arial, sans-serif"
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bodyStyle() {
  return `margin:0;padding:0;background-color:${EMAIL_THEME.pageTop};background-image:linear-gradient(180deg, ${EMAIL_THEME.pageTop} 0%, ${EMAIL_THEME.pageBottom} 100%);font-family:${EMAIL_THEME.fontBody};color:${EMAIL_THEME.text};-webkit-text-size-adjust:100%;text-size-adjust:100%;`;
}

function wrapperStyle() {
  return `padding:28px 16px;background-color:${EMAIL_THEME.pageTop};background-image:linear-gradient(180deg, ${EMAIL_THEME.pageTop} 0%, ${EMAIL_THEME.pageBottom} 100%);`;
}

function cardStyle() {
  return `width:100%;max-width:680px;background:${EMAIL_THEME.cardBackground};border:1px solid ${EMAIL_THEME.cardBorder};border-radius:24px;overflow:hidden;box-shadow:${EMAIL_THEME.shadow};`;
}

function headerStyle() {
  return `padding:16px 24px 14px 24px;background:${EMAIL_THEME.cardBackground};border-bottom:1px solid ${EMAIL_THEME.cardBorder};`;
}

function brandStyle() {
  return `margin:0;font-family:${EMAIL_THEME.fontDisplay};font-size:24px;line-height:1;letter-spacing:-0.03em;font-weight:800;color:${EMAIL_THEME.textStrong};`;
}

function chipStyle() {
  return `display:inline-block;padding:6px 10px;border:1px solid rgba(253, 200, 47, 0.26);border-radius:999px;background:${EMAIL_THEME.accentSoft};color:${EMAIL_THEME.accentInk};font-size:11px;line-height:1.2;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;white-space:nowrap;`;
}

function titleStyle() {
  return `margin:0;font-family:${EMAIL_THEME.fontDisplay};font-size:24px;line-height:1.25;letter-spacing:-0.02em;color:${EMAIL_THEME.textStrong};`;
}

function introStyle() {
  return `margin:10px 0 0 0;font-size:14px;line-height:1.65;color:${EMAIL_THEME.textMutedStrong};`;
}

function contentStyle() {
  return `padding:20px 24px 24px 24px;`;
}

function footerStyle() {
  return `margin:0;padding-top:14px;border-top:1px solid ${EMAIL_THEME.cardBorder};color:${EMAIL_THEME.textMuted};font-size:12px;line-height:1.6;`;
}

function contentParagraphStyle(margin = '0 0 14px 0') {
  return `margin:${margin};font-size:14px;line-height:1.7;color:${EMAIL_THEME.textMutedStrong};`;
}

function contentNoteStyle(margin = '0 0 12px 0') {
  return `margin:${margin};font-size:12px;line-height:1.6;color:${EMAIL_THEME.textMuted};`;
}

function ctaButtonStyle() {
  return `display:inline-block;padding:12px 18px;border:1px solid rgba(253, 200, 47, 0.28);border-radius:999px;background:linear-gradient(135deg, ${EMAIL_THEME.accent} 0%, ${EMAIL_THEME.accentBrass} 100%);color:${EMAIL_THEME.accentContrast};text-decoration:none;font-size:14px;font-weight:700;line-height:1.2;box-shadow:0 10px 24px rgba(15, 23, 42, 0.08);`;
}

function codeShellStyle() {
  return `margin:0 auto 18px auto;max-width:340px;padding:18px 20px;border:1px solid rgba(253, 200, 47, 0.28);border-radius:18px;background:rgba(253, 200, 47, 0.12);text-align:center;box-shadow:inset 0 1px 0 rgba(255, 255, 255, 0.42);`;
}

function codeLabelStyle() {
  return `margin:0 0 8px 0;color:${EMAIL_THEME.textMuted};font-size:12px;line-height:1.2;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;`;
}

function codeValueStyle() {
  return `margin:0;color:${EMAIL_THEME.accentInk};font-family:'SFMono-Regular','Cascadia Code','JetBrains Mono','Consolas',monospace;font-size:38px;line-height:1;font-weight:800;letter-spacing:0.2em;`;
}

function linkStyle() {
  return `color:${EMAIL_THEME.accentInk};text-decoration:underline;text-decoration-color:rgba(91, 67, 0, 0.28);word-break:break-all;`;
}

function emailShell({ title, pretitle, intro, contentHtml, footer, brandName, lang }) {
  const safeTitle = escapeHtml(title);
  const safePretitle = String(pretitle || '').trim() ? escapeHtml(pretitle) : '';
  const safeBrandName = escapeHtml(String(brandName || '').trim() || 'archimap');
  const safeIntro = escapeHtml(intro);
  const safeFooter = escapeHtml(footer);
  const safeLang = escapeHtml(normalizeEmailLocale(lang));

  return `<!doctype html>
<html lang="${safeLang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${safeTitle}</title>
</head>
<body style="${bodyStyle()}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="${wrapperStyle()}">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="${cardStyle()}">
          <tr>
            <td style="${headerStyle()}">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" valign="middle">
                    <p style="${brandStyle()}">${safeBrandName}</p>
                  </td>
                  <td align="right" valign="middle">
                    ${safePretitle ? `<span style="${chipStyle()}">${safePretitle}</span>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 24px 0 24px;background:${EMAIL_THEME.cardBackground};">
              <h1 style="${titleStyle()}">${safeTitle}</h1>
              <p style="${introStyle()}">${safeIntro}</p>
            </td>
          </tr>
          <tr>
            <td style="${contentStyle()}">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 22px 24px;background:${EMAIL_THEME.cardBackground};">
              <p style="${footerStyle()}">${safeFooter}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = {
  EMAIL_THEME,
  escapeHtml,
  emailShell,
  ctaButtonStyle,
  codeLabelStyle,
  codeShellStyle,
  codeValueStyle,
  contentNoteStyle,
  contentParagraphStyle,
  linkStyle
};
