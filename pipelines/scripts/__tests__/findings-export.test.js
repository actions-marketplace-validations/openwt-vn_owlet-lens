'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { postFindingsWebhook } = require('../lib/findings-export.js');

const payload = {
  repo: 'org/repo',
  prId: '42',
  findings: [{ filePath: 'a.js', line: 1, severity: 'HIGH', category: 'bug', body: 'oops' }],
  costUsd: 0.01,
  ts: '2026-09-09T00:00:00Z',
};

test('postFindingsWebhook returns ok:false on network error', async () => {
  const result = await postFindingsWebhook('http://127.0.0.1:1/', payload);
  assert.equal(result.ok, false);
  assert.ok(result.message);
});

test('postFindingsWebhook handles invalid URL gracefully', async () => {
  const result = await postFindingsWebhook('not-a-url', payload);
  assert.equal(result.ok, false);
});

test('postFindingsWebhook returns explicit timeout message on AbortError', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  try {
    const result = await postFindingsWebhook('http://example.com', payload);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('timed out'), `expected timeout message, got: ${result.message}`);
  } finally {
    globalThis.fetch = original;
  }
});
