'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appendAuditEntry } = require('../lib/audit-log.js');

test('appendAuditEntry creates file and appends JSONL', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const logPath = path.join(tmp, 'sub', 'audit.jsonl');

  appendAuditEntry(logPath, { event: 'review', prId: '42' });
  appendAuditEntry(logPath, { event: 'reply', prId: '42' });

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.event, 'review');
  assert.equal(first.prId, '42');
  assert.ok(first.ts);

  const second = JSON.parse(lines[1]);
  assert.equal(second.event, 'reply');

  fs.rmSync(tmp, { recursive: true });
});

test('appendAuditEntry handles existing file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const logPath = path.join(tmp, 'audit.jsonl');
  fs.writeFileSync(logPath, '{"existing":true}\n');

  appendAuditEntry(logPath, { event: 'new' });

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).existing, true);
  assert.equal(JSON.parse(lines[1]).event, 'new');

  fs.rmSync(tmp, { recursive: true });
});
