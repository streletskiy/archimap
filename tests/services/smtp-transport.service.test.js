const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

const {
  buildSmtpDeliveryCandidates,
  sendMailWithFallback
} = require('../../src/lib/server/services/smtp-transport.service');

test('buildSmtpDeliveryCandidates adds 2525 fallback for non-secure 587 config', () => {
  const candidates = buildSmtpDeliveryCandidates({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'user',
    pass: 'pass'
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].port, 587);
  assert.equal(candidates[1].port, 2525);
});

test('buildSmtpDeliveryCandidates keeps single candidate for secure transport', () => {
  const candidates = buildSmtpDeliveryCandidates({
    host: 'smtp-relay.brevo.com',
    port: 465,
    secure: true,
    user: 'user',
    pass: 'pass'
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].port, 465);
});

test('sendMailWithFallback retries on connection error and succeeds with fallback', async (t) => {
  const originalCreateTransport = nodemailer.createTransport;
  let call = 0;
  nodemailer.createTransport = () => {
    call += 1;
    const currentCall = call;
    return {
      async sendMail() {
        if (currentCall === 1) {
          const err = new Error('Greeting never received');
          err.code = 'ETIMEDOUT';
          err.command = 'CONN';
          throw err;
        }
        return { messageId: 'ok', accepted: ['test@example.com'], rejected: [], pending: [] };
      }
    };
  };
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  const result = await sendMailWithFallback({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    user: 'user',
    pass: 'pass',
    from: 'archimap <test@example.com>'
  }, {
    from: 'archimap <test@example.com>',
    to: 'test@example.com',
    subject: 'Test',
    text: 'Hi'
  });

  assert.equal(call, 2);
  assert.equal(result.info.messageId, 'ok');
});

test('sendMailWithFallback throws when SMTP accepts no recipients', async (t) => {
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    async sendMail() {
      return {
        messageId: 'queued-id',
        accepted: [],
        rejected: ['test@example.com'],
        pending: [],
        response: '550 rejected'
      };
    }
  });
  t.after(() => {
    nodemailer.createTransport = originalCreateTransport;
  });

  await assert.rejects(
    () => sendMailWithFallback({
      host: 'smtp-relay.brevo.com',
      port: 2525,
      secure: false,
      user: 'user',
      pass: 'pass',
      from: 'archimap <test@example.com>'
    }, {
      from: 'archimap <test@example.com>',
      to: 'test@example.com',
      subject: 'Test',
      text: 'Hi'
    }),
    /accepted no recipients/i
  );
});
