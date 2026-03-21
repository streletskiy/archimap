const nodemailer = require('nodemailer');

type LooseSmtpError = Error & {
  code?: string;
  command?: string;
  details?: LooseRecord;
};

function normalizeSmtpConfig(raw: LooseRecord = {}) {
  return {
    url: String(raw.url || '').trim(),
    host: String(raw.host || '').trim(),
    port: Number(raw.port || 587),
    secure: raw.secure === true || String(raw.secure ?? 'false').toLowerCase() === 'true',
    user: String(raw.user || '').trim(),
    pass: String(raw.pass || '').trim(),
    from: String(raw.from || raw.user || '').trim()
  };
}

function buildSmtpDeliveryCandidates(raw: LooseRecord = {}) {
  const smtpConfig = normalizeSmtpConfig(raw);
  if (smtpConfig.url) {
    return [{ type: 'url', url: smtpConfig.url, label: 'smtp_url' }];
  }

  const out = [{
    type: 'host',
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    user: smtpConfig.user,
    pass: smtpConfig.pass,
    label: `host:${smtpConfig.host}:${smtpConfig.port}`
  }];

  // Some providers/networks intermittently drop 587. Retry submission on 2525.
  if (!smtpConfig.secure && Number(smtpConfig.port) === 587) {
    out.push({
      type: 'host',
      host: smtpConfig.host,
      port: 2525,
      secure: false,
      user: smtpConfig.user,
      pass: smtpConfig.pass,
      label: `host:${smtpConfig.host}:2525`
    });
  }

  return out;
}

function isConnectionStageError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  const command = String(error?.command || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();

  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return true;
  }
  if (command === 'CONN') return true;
  if (message.includes('greeting never received')) return true;
  if (message.includes('connection timeout')) return true;
  if (message.includes('timed out')) return true;
  return false;
}

function createTransportFromCandidate(candidate) {
  if (candidate.type === 'url') {
    return nodemailer.createTransport(candidate.url);
  }
  return nodemailer.createTransport({
    host: candidate.host,
    port: candidate.port,
    secure: candidate.secure,
    auth: { user: candidate.user, pass: candidate.pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });
}

function toList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [];
}

async function sendMailWithFallback(rawSmtpConfig, mailOptions: LooseRecord = {}, options: LooseRecord = {}) {
  const logger = options.logger || console;
  const logContext = options.logContext || {};
  const candidates = buildSmtpDeliveryCandidates(rawSmtpConfig);
  let lastError: LooseSmtpError | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const transporter = createTransportFromCandidate(candidate);
      const info = await transporter.sendMail(mailOptions);
      const accepted = toList(info?.accepted);
      const rejected = toList(info?.rejected);
      const pending = toList(info?.pending);
      if (accepted.length === 0) {
        const err = new Error('SMTP accepted no recipients') as LooseSmtpError;
        err.code = 'EENVELOPE';
        err.command = 'RCPT TO';
        err.details = { rejected, pending, response: String(info?.response || '') };
        throw err;
      }
      if (index > 0) {
        logger.warn('smtp_delivery_fallback_used', {
          ...logContext,
          candidate: candidate.label
        });
      }
      logger.info('smtp_delivery_sent', {
        ...logContext,
        candidate: candidate.label,
        messageId: String(info?.messageId || ''),
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        pendingCount: pending.length,
        response: String(info?.response || '')
      });
      return { info, candidate };
    } catch (error) {
      lastError = error as LooseSmtpError;
      const canRetry = index < (candidates.length - 1) && isConnectionStageError(error);
      logger.warn('smtp_delivery_attempt_failed', {
        ...logContext,
        candidate: candidate.label,
        code: String(error?.code || ''),
        command: String(error?.command || ''),
        error: String(error?.message || error),
        details: error?.details || null,
        willRetry: canRetry
      });
      if (!canRetry) break;
    }
  }

  throw lastError || new Error('SMTP delivery failed');
}

module.exports = {
  normalizeSmtpConfig,
  buildSmtpDeliveryCandidates,
  sendMailWithFallback
};
