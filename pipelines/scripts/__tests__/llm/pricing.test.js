// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePricing, calculateCost } = require('../../lib/llm/pricing.js');

test('resolvePricing: built-in anthropic claude-opus-4-7', () => {
  const p = resolvePricing('anthropic', 'claude-opus-4-7', {});
  assert.deepEqual(p, { inputPerMTok: 5, outputPerMTok: 25 });
});

test('resolvePricing: built-in gemini-2.5-pro', () => {
  const p = resolvePricing('gemini', 'gemini-2.5-pro', {});
  assert.deepEqual(p, { inputPerMTok: 1.25, outputPerMTok: 10 });
});

test('resolvePricing: built-in deepseek-chat', () => {
  const p = resolvePricing('deepseek', 'deepseek-chat', {});
  assert.deepEqual(p, { inputPerMTok: 0.27, outputPerMTok: 1.10 });
});

test('resolvePricing: override wins over built-in', () => {
  const p = resolvePricing('anthropic', 'claude-opus-4-7', {
    'claude-opus-4-7': { inputPerMTok: 4, outputPerMTok: 20 },
  });
  assert.deepEqual(p, { inputPerMTok: 4, outputPerMTok: 20 });
});

test('resolvePricing: unknown model returns null', () => {
  const p = resolvePricing('anthropic', 'no-such-model', {});
  assert.equal(p, null);
});

test('calculateCost: anthropic claude-opus-4-7 with 1M in, 0.5M out', () => {
  const c = calculateCost('anthropic', 'claude-opus-4-7',
    { inputTokens: 1_000_000, outputTokens: 500_000 }, {});
  assert.equal(c.inputCost, 5);
  assert.equal(c.outputCost, 12.5);
  assert.equal(c.totalCost, 17.5);
});

test('calculateCost: unknown model returns zeros + priced:false', () => {
  const c = calculateCost('anthropic', 'unknown-model', { inputTokens: 1000, outputTokens: 500 }, {});
  assert.deepEqual(c, { inputCost: 0, outputCost: 0, totalCost: 0, cacheCreationCost: 0, cacheReadCost: 0, priced: false });
});

test('calculateCost: priced:true when pricing resolves', () => {
  const c = calculateCost('anthropic', 'claude-opus-4-7', { inputTokens: 1_000_000, outputTokens: 0 }, {});
  assert.equal(c.priced, true);
});

test('calculateCost: modelstack unknown model → zeros + priced:false', () => {
  const c = calculateCost('modelstack', 'whatever/model', { inputTokens: 1000, outputTokens: 500 }, {});
  assert.equal(c.totalCost, 0);
  assert.equal(c.priced, false);
});

test('calculateCost: modelstack with YAML pricing override → priced:true + cost', () => {
  const c = calculateCost('modelstack', 'some/model', { inputTokens: 1_000_000, outputTokens: 0 }, {
    'some/model': { inputPerMTok: 2, outputPerMTok: 8 },
  });
  assert.equal(c.priced, true);
  assert.equal(c.inputCost, 2);
});

test('calculateCost: anthropic with cache_read tokens applies 0.10x multiplier', () => {
  const c = calculateCost('anthropic', 'claude-opus-4-7', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  }, {});
  // 1M cached read tokens * $5/M input * 0.10 = $0.50
  assert.equal(c.cacheReadCost, 0.5);
  assert.equal(c.totalCost, 0.5);
});

test('calculateCost: anthropic with cache_creation tokens applies 1.25x multiplier', () => {
  const c = calculateCost('anthropic', 'claude-opus-4-7', {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 1_000_000,
  }, {});
  // 1M creation tokens * $5/M input * 1.25 = $6.25
  assert.equal(c.cacheCreationCost, 6.25);
  assert.equal(c.totalCost, 6.25);
});

// Rates from https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-23).
test('resolvePricing: built-in Claude 5.5 models', () => {
  assert.deepEqual(resolvePricing('anthropic', 'claude-opus-5-5', {}),
    { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.20 });
  assert.deepEqual(resolvePricing('anthropic', 'claude-sonnet-5-5', {}),
    { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.10 });
  assert.deepEqual(resolvePricing('anthropic', 'claude-haiku-5-5', {}),
    { inputPerMTok: 0.10, outputPerMTok: 0.50, longContext: { thresholdTokens: 100_000, multiplier: 5 } });
});

test('calculateCost: claude-opus-5-5 bills cache reads at its own rate, not 0.1x input', () => {
  const c = calculateCost('anthropic', 'claude-opus-5-5', {
    inputTokens: 1_000_000, outputTokens: 1_000_000,
    cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000,
  }, {});
  assert.equal(c.inputCost, 4);
  assert.equal(c.outputCost, 20);
  assert.equal(c.cacheCreationCost, 5);
  assert.equal(c.cacheReadCost, 0.2);
  assert.equal(c.totalCost, 29.2);
});

test('calculateCost: claude-haiku-5-5 keeps the 0.1x cache-read multiplier', () => {
  const c = calculateCost('anthropic', 'claude-haiku-5-5',
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 50_000 }, {});
  assert.equal(c.cacheReadCost, 0.0005);
});

test('resolvePricing: override may set cacheReadPerMTok', () => {
  const p = resolvePricing('modelstack', 'm', {
    m: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  });
  assert.deepEqual(p, { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 });
});

test('resolvePricing: a null cacheReadPerMTok means unset, not free cache reads', () => {
  const p = resolvePricing('modelstack', 'm', { m: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: null } });
  assert.deepEqual(p, { inputPerMTok: 4, outputPerMTok: 20 });
  const c = calculateCost('modelstack', 'm', { cacheReadInputTokens: 1_000_000 },
    { m: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: null } });
  assert.equal(c.cacheReadCost, 0.4);
});

test('calculateCost: claude-haiku-5-5 prompts over 100,000 tokens bill every rate at 5x', () => {
  // Prompt length counts uncached input plus cache writes and cache reads.
  const c = calculateCost('anthropic', 'claude-haiku-5-5', {
    inputTokens: 60_000, outputTokens: 1_000_000,
    cacheCreationInputTokens: 30_000, cacheReadInputTokens: 20_000,
  }, {});
  assert.equal(c.inputCost, 0.03);          // 60K x $0.50
  assert.equal(c.outputCost, 2.5);          // 1M x $2.50
  assert.equal(c.cacheCreationCost, 0.01875); // 30K x $0.625
  assert.equal(c.cacheReadCost, 0.001);     // 20K x $0.05
});

test('calculateCost: claude-haiku-5-5 at exactly 100,000 prompt tokens keeps the lower tier', () => {
  const c = calculateCost('anthropic', 'claude-haiku-5-5',
    { inputTokens: 100_000, outputTokens: 0 }, {});
  assert.equal(c.inputCost, 0.01);
});

test('resolvePricing: an override replaces the built-in entry as a whole', () => {
  const p = resolvePricing('anthropic', 'claude-opus-5-5', {
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  });
  assert.deepEqual(p, { inputPerMTok: 4, outputPerMTok: 20 });
});

test('calculateCost: a longContext key in a config override is ignored, never NaN', () => {
  const override = { m: { inputPerMTok: 1, outputPerMTok: 1, longContext: { multiplier: 'x' } } };
  assert.deepEqual(resolvePricing('modelstack', 'm', override), { inputPerMTok: 1, outputPerMTok: 1 });
  const c = calculateCost('modelstack', 'm', { inputTokens: 1_000_000, outputTokens: 0 }, override);
  assert.equal(c.totalCost, 1);
});
