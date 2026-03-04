function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emailShell({ title, pretitle, intro, contentHtml, footer }) {
  return `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;background:#f8fafc;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:14px 20px;border-bottom:1px solid #e2e8f0;background:#ffffff;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:26px;font-weight:800;line-height:1;letter-spacing:-0.02em;color:#0f172a;">archimap</span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 24px 12px 24px;background:linear-gradient(180deg,#ffffff 0%,#f8faff 100%);">
              <div style="display:inline-block;padding:5px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;">${escapeHtml(pretitle)}</div>
              <h1 style="margin:12px 0 0 0;font-size:24px;line-height:1.25;color:#0f172a;">${escapeHtml(title)}</h1>
              <p style="margin:10px 0 0 0;font-size:14px;line-height:1.6;color:#475569;">${escapeHtml(intro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 24px 20px 24px;">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px 20px 24px;border-top:1px solid #f1f5f9;background:#fcfdff;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">${escapeHtml(footer)}</p>
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
  escapeHtml,
  emailShell
};
