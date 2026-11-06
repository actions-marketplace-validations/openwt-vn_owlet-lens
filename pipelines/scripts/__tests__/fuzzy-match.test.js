// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { textSimilarity } = require('../lib/fuzzy-match.js');

test('textSimilarity: identical text scores 1', () => {
  assert.equal(textSimilarity('manual array copy loop', 'manual array copy loop'), 1);
});

test('textSimilarity: empty strings score 0', () => {
  assert.equal(textSimilarity('', 'manual array copy'), 0);
  assert.equal(textSimilarity('manual array copy', ''), 0);
});

test('textSimilarity: ignores marker HTML comments and inline-code markers', () => {
  const withHtmlMarker =
    'Manual array copy loop.\n<!-- ai-review:v1:active -->\n<!-- ai-review:fingerprint=abc123 -->';
  const withInlineMarker = 'Manual array copy loop. `ai-review:v1:active`';
  // Marker boilerplate must not contribute to the score either way.
  assert.equal(textSimilarity(withHtmlMarker, 'Manual array copy loop.'), 1);
  assert.equal(textSimilarity(withInlineMarker, 'Manual array copy loop.'), 1);
});

test('textSimilarity: unrelated findings score low', () => {
  const a = 'Manual array copy loop when activePlayers is already IReadOnlyList';
  const b = 'SlotColor uses Single() which throws InvalidOperationException on zero matches';
  assert.ok(textSimilarity(a, b) < 0.2);
});
