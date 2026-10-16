'use strict';
// Run: node tests/container-cleanup.cjs (isolated files; no server or AI).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const source = path.join(__dirname, '../tools/clean-container-field.mjs');
const valid = 'MSKU1465327';
const other = 'CMAU3487514';
const typo = 'SKUH6510577';
const corrected = 'SKHU6510577';
let pass = 0;

function run(container, args, check, origin = 'docs:fixture.pdf@2026-09-23T00:00:00Z') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-container-cleanup-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    const script = path.join(root, 'tools/clean-container-field.mjs');
    fs.copyFileSync(source, script);
    const records = [
      { po_so: 'TEST-1', container, bl_awb: 'BOOKING123', note: 'Keep this note',
        _ts: 123, _src: { container: origin } },
      { po_so: 'TEST-2', container: valid, _ts: 456, _src: { container: origin } },
    ];
    const raw = JSON.stringify(records, null, 2);
    const track = path.join(root, 'tracking_data.json');
    const audit = path.join(root, 'tracking_audit.jsonl');
    const priorAudit = JSON.stringify({ action: 'fixture_existing' }) + '\n';
    fs.writeFileSync(track, raw);
    fs.writeFileSync(audit, priorAudit);
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const afterRaw = fs.readFileSync(track, 'utf8');
    const after = JSON.parse(afterRaw);
    const auditRaw = fs.readFileSync(audit, 'utf8');
    assert.equal(after.length, records.length);
    assert.deepEqual(after[1], records[1]);
    const { container: ignoredContainer, _ts: ignoredTs, ...untouched } = after[0];
    const { container: beforeContainer, _ts: beforeTs, ...beforeUntouched } = records[0];
    assert.deepEqual(untouched, beforeUntouched);
    assert.ok(auditRaw.startsWith(priorAudit));
    check({ after, afterRaw, raw, auditRaw, priorAudit, root, result,
      audit: auditRaw.trim().split('\n').map(line => JSON.parse(line)) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ok(label, fn) {
  fn();
  pass++;
  console.log('PASS ' + label);
}

for (const [label, input, expected] of [
  ['typo after valid containers', `${valid}, ${other}, ${typo}`, `${valid}, ${other}, ${corrected}`],
  ['typo before valid containers', `${typo}, ${valid}, ${other}`, `${corrected}, ${valid}, ${other}`],
  ['typo between valid containers', `${valid}; ${typo} / ${other}`, `${valid}, ${corrected}, ${other}`],
]) {
  ok(label, () => run(input, ['--apply', '--fix-transposed'], ({ after, audit, root, raw }) => {
    assert.equal(after[0].container, expected, 'Valid container numbers must survive the typo correction');
    assert.equal(audit[1].action, 'container_typo_fix');
    assert.equal(audit[1].detail.from, input);
    assert.equal(audit[1].detail.to, expected);
    assert.deepEqual(audit[1].detail.dropped, []);
    const backups = fs.readdirSync(path.join(root, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(root, 'backups', backups[0]), 'utf8'), raw);
  }));
}

ok('audit only drops non-container values', () =>
  run(`${valid}, ${typo}, SEAL123, 40HC`, ['--apply', '--fix-transposed'], ({ after, audit }) => {
    assert.equal(after[0].container, `${valid}, ${corrected}`);
    assert.deepEqual(audit[1].detail.dropped, ['SEAL123', '40HC']);
  }));

ok('single typo still gets corrected', () =>
  run(typo, ['--apply', '--fix-transposed'], ({ after }) => assert.equal(after[0].container, corrected)));

function unchanged({ raw, afterRaw, auditRaw, priorAudit }) {
  assert.equal(afterRaw, raw);
  assert.equal(auditRaw, priorAudit);
}

ok('dry run leaves tracking and audit untouched', () =>
  run(`${valid}, ${typo}`, ['--fix-transposed'], state => {
    unchanged(state);
    assert.ok(!fs.existsSync(path.join(state.root, 'backups')));
    assert.ok(state.result.stdout.includes(`${valid}, ${corrected}`));
  }));

ok('no fix flag leaves near misses untouched', () =>
  run(`${valid}, ${typo}`, ['--apply'], unchanged));

ok('multiple near misses remain untouched', () =>
  run(`${valid}, ${typo}, ${typo}`, ['--apply', '--fix-transposed'], unchanged));

ok('manual values remain untouched', () =>
  run(`${valid}, ${typo}`, ['--apply', '--fix-transposed'], unchanged, 'manual:fixture@2026-09-23T00:00:00Z'));

ok('ordinary cleanup retains valid containers', () =>
  run(`${valid}, SEAL123, ${other}`, ['--apply'], ({ after, audit }) => {
    assert.equal(after[0].container, `${valid}, ${other}`);
    assert.deepEqual(audit[1].detail.dropped, ['SEAL123']);
  }));

ok('value duplicated in BL can still be cleared', () =>
  run('BOOKING123', ['--apply'], ({ after }) => assert.ok(!Object.hasOwn(after[0], 'container'))));

ok('unique non-container value remains untouched', () =>
  run('UNIQUE123', ['--apply'], unchanged));

console.log(`${pass}/${pass} container cleanup cases passed`);
