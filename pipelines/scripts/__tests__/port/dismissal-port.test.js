'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDismissedContext } = require('../../lib/port/dismissal-port.js');

const botRoot = (body) => ({ isBot: true, body });
const humanRoot = (body) => ({ isBot: false, body });

test('empty threads → empty prompt, count 0', () => {
  const r = buildDismissedContext([], 'ai-review');
  assert.equal(r.prompt, '');
  assert.equal(r.dismissedCount, 0);
});

test('active threads excluded', () => {
  const threads = [{
    id: '1', status: 'active', filePath: 'a.ts', line: 1,
    comments: [botRoot('**[HIGH/security]** msg')],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 0);
});

test('wontfix bot-rooted thread with marker.version included', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 5,
    comments: [botRoot('**[HIGH/security]** ignore me')],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 1);
  assert.ok(r.prompt.includes('[DISMISSED CONTEXT]'));
  assert.ok(r.prompt.includes('a.ts:5'));
  assert.ok(r.prompt.includes('[HIGH/security]'));
  assert.ok(r.prompt.includes('(wontfix)'));
});

test('fixed bot-rooted thread with marker.version included', () => {
  const threads = [{
    id: '2', status: 'fixed', filePath: 'b.ts', line: 9,
    comments: [botRoot('**[LOW/style]** trailing whitespace')],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 1);
  assert.ok(r.prompt.includes('(fixed)'));
});

test('wontfix without marker.version excluded', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
    comments: [botRoot('**[HIGH/security]** msg')],
    marker: { version: null },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 0);
});

test('wontfix with no marker object excluded', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
    comments: [botRoot('msg')],
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 0);
});

test('wontfix human-rooted thread excluded', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
    comments: [humanRoot('**[HIGH/security]** msg')],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 0);
});

test('thread with empty comments excluded', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
    comments: [],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 0);
});

test('falls back to UNKNOWN/unknown when sev/cat header missing', () => {
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 3,
    comments: [botRoot('plain message no sev header')],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 1);
  assert.ok(r.prompt.includes('[UNKNOWN/unknown]'));
});

test('summary truncates to first line, max 200 chars', () => {
  const long = 'x'.repeat(500);
  const threads = [{
    id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
    comments: [botRoot(`**[HIGH/security]** ${long}\nsecond line`)],
    marker: { version: 'v1' },
  }];
  const r = buildDismissedContext(threads, 'ai-review');
  const summaryLine = r.prompt.split('\n').find((l) => l.startsWith('- a.ts'));
  assert.ok(summaryLine.length < 300);
  assert.ok(!summaryLine.includes('second line'));
});

test('multiple eligible threads listed in order', () => {
  const threads = [
    {
      id: '1', status: 'wontfix', filePath: 'a.ts', line: 1,
      comments: [botRoot('**[HIGH/security]** A')],
      marker: { version: 'v1' },
    },
    {
      id: '2', status: 'fixed', filePath: 'b.ts', line: 2,
      comments: [botRoot('**[LOW/style]** B')],
      marker: { version: 'v1' },
    },
  ];
  const r = buildDismissedContext(threads, 'ai-review');
  assert.equal(r.dismissedCount, 2);
  const aIdx = r.prompt.indexOf('a.ts:1');
  const bIdx = r.prompt.indexOf('b.ts:2');
  assert.ok(aIdx > 0 && bIdx > aIdx);
});
