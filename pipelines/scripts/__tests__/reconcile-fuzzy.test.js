// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcilePort } = require('../lib/reconcile.js');
const { fingerprint } = require('../lib/fingerprint.js');

// Regression coverage for game-seahorse PR #24: the same finding
// ("manual array copy loop" in BoardController.cs) was reposted as a new
// thread on 3 consecutive review runs because its line shifted (unrelated
// fixes landing above it) and the LLM re-graded its category/severity
// differently each time, changing the fingerprint every run.

const mkThread = (overrides) => ({
  id: 't1', status: 'active', filePath: 'src/a.js', line: 236,
  comments: [{
    isBot: true,
    body:
      '**[LOW/performance]** Manual array copy in ResolveActivePlayers allocates and ' +
      'loops when Array.Copy or activePlayers.ToArray() would be clearer and ' +
      'potentially faster for larger arrays. Consider: return activePlayers.ToArray();' +
      '\n\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=1d50d718fe1d2c8a -->',
  }],
  marker: { fingerprint: '1d50d718fe1d2c8a', version: '1' },
  ...overrides,
});

test('fuzzy dedup: re-graded finding at a shifted line is claimed (no duplicate thread, no redundant reply)', () => {
  const existing = [mkThread()];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 253,
    body:
      'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
      'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
      'iteration and improve readability.',
    severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
  }]);

  assert.equal(result.toPost.length, 0, 'must not spawn a duplicate thread');
  assert.equal(result.toReply.length, 0, 'bot has the last word -> reply suppressed');
  assert.equal(result.toClose.length, 0, 'a matched thread must stay claimed, not closed');
});

test('fuzzy dedup: a third re-detection (different category+line again) still matches the same thread', () => {
  const existing = [mkThread()];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 254,
    body:
      "The manual array copy loop can be replaced with Array.Copy for clarity: " +
      "'Array.Copy(activePlayers.ToArray(), copy, copy.Length);' or use " +
      "activePlayers.ToArray() directly if mutability isn't a concern.",
    severity: 'LOW', category: 'style', ruleId: 'style',
  }]);

  assert.equal(result.toPost.length, 0);
  assert.equal(result.toReply.length, 0, 'bot has the last word -> reply suppressed');
});

test('fuzzy dedup: does not match an unrelated finding in the same file', () => {
  const existing = [mkThread()];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 106,
    body:
      'ResolveActivePlayers returns a bool array but never validates that at least ' +
      'one player is active. Add validation to throw ArgumentException when all ' +
      'entries are false.',
    severity: 'MEDIUM', category: 'bug', ruleId: 'bug',
  }]);

  assert.equal(result.toPost.length, 1, 'a genuinely different finding must still post');
  assert.equal(result.toReply.length, 0);
});

test('fuzzy dedup: line drift beyond tolerance falls back to toPost', () => {
  const existing = [mkThread()];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 236 + 1000,
    body:
      'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
      'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
      'iteration and improve readability.',
    severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
  }]);

  assert.equal(result.toPost.length, 1);
  assert.equal(result.toReply.length, 0);
});

test('fuzzy dedup: re-detection of a wontfix/fixed thread lands as a quiet reply, not a duplicate post or a reopen', () => {
  // Regression coverage for game-seahorse PR #47: findings that got wontfix'd
  // immediately (same round) were excluded from the fuzzy pool on the very
  // next round, so line drift there could never be caught -- the same
  // finding reposted as a brand-new thread up to 3x (ApplyTransform
  // Quaternion-caching, IsAtDefault-caching, Configure() validation, etc.),
  // with the dev re-arguing the identical wontfix rationale each time.
  const existing = [mkThread({ status: 'wontfix' })];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 253,
    body:
      'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
      'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
      'iteration and improve readability.',
    severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
  }]);

  assert.equal(result.toPost.length, 0, 'must not spawn a duplicate thread for an already-dismissed finding');
  assert.equal(result.toReply.length, 0, 'bot has the last word -> redundant reply suppressed');
  assert.equal(result.toReopen.length, 0, 'a fuzzy match must never flip a dismissed thread back to active');
});

test('fuzzy dedup: replies when a human spoke since the last bot comment', () => {
  const existing = [mkThread({
    comments: [
      { isBot: true, body: '**[LOW/performance]** Manual array copy loop in ResolveActivePlayers allocates and loops.' },
      { isBot: false, body: 'still not addressed' },
    ],
  })];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 253,
    body:
      'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
      'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
      'iteration and improve readability.',
    severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
  }]);

  assert.equal(result.toPost.length, 0);
  assert.equal(result.toReply.length, 1, 'there is a human comment to respond to');
  assert.equal(result.toReply[0].thread.id, 't1');
});

test('fuzzy dedup: never matches a human-authored thread even if line-adjacent', () => {
  const existing = [mkThread({
    comments: [{ isBot: false, body: 'Manual array copy loop, activePlayers ToArray' }],
    marker: { fingerprint: null, version: null },
  })];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 253,
    body:
      'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
      'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
      'iteration and improve readability.',
    severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
  }]);

  assert.equal(result.toPost.length, 1);
});

test('fuzzy dedup: two candidate threads in the same file each claim at most one finding', () => {
  const t1 = mkThread({ id: 't1', line: 100, marker: { fingerprint: 'fp1', version: '1' } });
  const t2 = mkThread({
    id: 't2', line: 300, marker: { fingerprint: 'fp2', version: '1' },
    comments: [{
      isBot: true,
      body: 'Unrelated slot-color helper uses Single() which throws on zero or multiple matches.',
    }],
  });
  const result = reconcilePort([t1, t2], [
    {
      filePath: 'src/a.js', line: 101,
      body:
        'Manual array copy loop when activePlayers is already IReadOnlyList<bool>. Use ' +
        'activePlayers.ToArray() (with System.Linq) or Array.Copy to avoid manual ' +
        'iteration and improve readability.',
      severity: 'MEDIUM', category: 'performance', ruleId: 'performance',
    },
    {
      filePath: 'src/a.js', line: 301,
      body: 'SlotColor uses Single() which throws InvalidOperationException on zero or multiple matches.',
      severity: 'MEDIUM', category: 'bug', ruleId: 'bug',
    },
  ]);

  assert.equal(result.toPost.length, 0, 'both findings are claimed -> no duplicate threads');
  assert.equal(result.toReply.length, 0, 'bot has the last word -> replies suppressed');
});

test('ruleId is category-only: severity re-grading alone does not change fingerprint identity', () => {
  const fp = fingerprint('src/a.js', 10, 'bug');
  const existing = [{
    id: 't1', status: 'active', filePath: 'src/a.js', line: 10,
    comments: [{ isBot: true, body: '**[LOW/bug]** missing null check' }],
    marker: { fingerprint: fp, version: '1' },
  }];
  const result = reconcilePort(existing, [{
    filePath: 'src/a.js', line: 10, body: 'missing null check',
    severity: 'MEDIUM', category: 'bug', ruleId: 'bug',
  }]);

  assert.equal(result.toPost.length, 0, 'must not spawn a duplicate thread');
  assert.equal(result.toReply.length, 0, 'no reply when bot already has last word');
  assert.equal(result.toClose.length, 0, 'thread is still claimed');
});
