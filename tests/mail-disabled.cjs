'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../lib/mailer.cjs'), 'utf8');

function load(disabled) {
  let smtpCalls = 0;
  let httpCalls = 0;
  const env = {
    MAIL_USER: 'fixture@example.invalid', MAIL_PASS: 'fixture-only',
    ALERT_EMAIL_TO: 'fixture@example.invalid',
  };
  if (disabled !== undefined) env.MAIL_DISABLED = disabled;
  const context = {
    process: { env }, module: { exports: {} },
    fetch: async () => { httpCalls++; throw new Error('unexpected HTTP'); },
    require: name => {
      assert.equal(name, 'nodemailer');
      smtpCalls++;
      return { createTransport: () => ({
        verify: async () => { throw new Error('535 fixture authentication failure'); },
        sendMail: async () => { throw new Error('unexpected delivery'); },
      }) };
    },
  };
  vm.runInNewContext(source, context);
  return { mail: context.module.exports, calls: () => ({ smtpCalls, httpCalls }) };
}

(async () => {
  const disabled = load('1');
  assert.equal(disabled.mail.mailMode(), 'disabled');
  const result = await disabled.mail.verifyMail();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'disabled');
  assert.equal(result.disabled, true);
  assert.equal(await disabled.mail.sendMail({ subject: 'fixture', text: 'fixture' }), false);
  assert.deepEqual(disabled.calls(), { smtpCalls: 0, httpCalls: 0 });
  console.log('PASS explicitly disabled mail performs no authentication or delivery');
  for (const value of [undefined, '0', 'false', '']) {
    const enabled = load(value);
    assert.equal(enabled.mail.mailMode(), 'smtp');
    const verified = await enabled.mail.verifyMail();
    assert.equal(verified.ok, false);
    assert.match(verified.error, /535/);
    assert.equal(enabled.calls().smtpCalls, 1);
  }
  console.log('PASS missing or non-enabled flag preserves SMTP verification failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
