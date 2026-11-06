// @ts-check
'use strict';

const BUILTIN = Object.freeze({
  anthropic: Object.freeze({
    'claude-opus-4-7':           Object.freeze({ inputPerMTok: 5, outputPerMTok: 25 }),
    'claude-sonnet-4-6':         Object.freeze({ inputPerMTok: 3, outputPerMTok: 15 }),
    'claude-haiku-4-5-20251001': Object.freeze({ inputPerMTok: 1, outputPerMTok: 5 }),
    // Claude 5.5 rates read 2026-10-23 from
    // https://platform.claude.com/docs/en/about-claude/pricing. Opus and Sonnet
    // 5.5 bill cache reads at 0.05x input, so they carry an explicit rate.
    // Haiku 5.5 charges 5x every rate for prompts over 100,000 tokens.
    'claude-opus-5-5':           Object.freeze({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.20 }),
    'claude-sonnet-5-5':         Object.freeze({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.10 }),
    'claude-haiku-5-5':          Object.freeze({
      inputPerMTok: 0.10, outputPerMTok: 0.50,
      longContext: Object.freeze({ thresholdTokens: 100_000, multiplier: 5 }),
    }),
  }),
  gemini: Object.freeze({
    'gemini-2.5-pro':   Object.freeze({ inputPerMTok: 1.25, outputPerMTok: 10 }),
    'gemini-2.5-flash': Object.freeze({ inputPerMTok: 0.30, outputPerMTok: 2.5 }),
  }),
  deepseek: Object.freeze({
    'deepseek-v4-pro':   Object.freeze({ inputPerMTok: 0.435, outputPerMTok: 0.87 }),
    'deepseek-v4-flash': Object.freeze({ inputPerMTok: 0.14, outputPerMTok: 0.28 }),
    'deepseek-chat':     Object.freeze({ inputPerMTok: 0.27, outputPerMTok: 1.10 }),
    'deepseek-reasoner': Object.freeze({ inputPerMTok: 0.55, outputPerMTok: 2.19 }),
  }),
  modelstack: Object.freeze({}),
});

/**
 * @typedef {{ thresholdTokens: number, multiplier: number }} LongContextPricing
 * @typedef {{
 *   inputPerMTok: number,
 *   outputPerMTok: number,
 *   cacheReadPerMTok?: number,
 *   longContext?: LongContextPricing,
 * }} ModelPricing
 */

/** @param {unknown} v */
function isSet(v) {
  return v !== undefined && v !== null;
}

/**
 * Copy a pricing entry, keeping `cacheReadPerMTok` only when it is set. A null
 * `cacheReadPerMTok` (an empty YAML key) means unset. `longContext` is copied
 * only for built-in entries: config validation does not check it, so a config
 * override never carries it.
 *
 * @param {any} p
 * @param {{ builtin: boolean }} opts
 * @returns {ModelPricing}
 */
function toPricing(p, { builtin }) {
  return {
    inputPerMTok: Number(p.inputPerMTok),
    outputPerMTok: Number(p.outputPerMTok),
    ...(isSet(p.cacheReadPerMTok) ? { cacheReadPerMTok: Number(p.cacheReadPerMTok) } : {}),
    ...(builtin && isSet(p.longContext) ? { longContext: p.longContext } : {}),
  };
}

/**
 * Resolve per-model pricing. Override (top-level `pricing.{model}`) wins over built-in.
 *
 * @param {string} provider
 * @param {string} model
 * @param {Record<string, ModelPricing>} override
 * @returns {ModelPricing | null}
 */
function resolvePricing(provider, model, override) {
  if (override && override[model]) return toPricing(override[model], { builtin: false });
  const table = BUILTIN[provider];
  if (!table) return null;
  const p = table[model];
  return p ? toPricing(p, { builtin: true }) : null;
}

// Anthropic prompt-caching multipliers vs base input rate.
//   cache_creation_input_tokens: 1.25x  (writing to cache)
//   cache_read_input_tokens:     0.10x  (reading from cache), unless the
//                                model's pricing sets cacheReadPerMTok
// Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const CACHE_CREATION_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

/**
 * Compute cost from token usage and pricing.
 *
 * Anthropic prompt-caching: `usage.cacheCreationInputTokens` and
 * `usage.cacheReadInputTokens` are billed at different rates than uncached
 * input. `usage.inputTokens` already excludes the cache buckets per the
 * Anthropic billing contract — we sum the three buckets, not double-count.
 *
 * @param {string} provider
 * @param {string} model
 * @param {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheCreationInputTokens?: number,
 *   cacheReadInputTokens?: number,
 * }} usage
 * @param {Record<string, ModelPricing>} override
 * @returns {{ inputCost: number, outputCost: number, totalCost: number, cacheCreationCost: number, cacheReadCost: number, priced: boolean }}
 */
function calculateCost(provider, model, usage, override) {
  const pricing = resolvePricing(provider, model, override);
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, cacheCreationCost: 0, cacheReadCost: 0, priced: false };
  }
  const inT = usage.inputTokens ?? 0;
  const outT = usage.outputTokens ?? 0;
  const cacheCreateT = usage.cacheCreationInputTokens ?? 0;
  const cacheReadT = usage.cacheReadInputTokens ?? 0;
  // A long-context tier prices the whole request by its prompt length, which
  // counts uncached input, cache writes and cache reads together.
  const lc = pricing.longContext;
  const scale = lc && inT + cacheCreateT + cacheReadT > lc.thresholdTokens ? lc.multiplier : 1;
  const inputPerMTok = pricing.inputPerMTok * scale;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const inputCost = round((inT / 1_000_000) * inputPerMTok);
  const outputCost = round((outT / 1_000_000) * pricing.outputPerMTok * scale);
  const cacheCreationCost = round((cacheCreateT / 1_000_000) * inputPerMTok * CACHE_CREATION_MULTIPLIER);
  const cacheReadPerMTok = (pricing.cacheReadPerMTok ?? pricing.inputPerMTok * CACHE_READ_MULTIPLIER) * scale;
  const cacheReadCost = round((cacheReadT / 1_000_000) * cacheReadPerMTok);
  const totalCost = round(inputCost + outputCost + cacheCreationCost + cacheReadCost);
  return { inputCost, outputCost, totalCost, cacheCreationCost, cacheReadCost, priced: true };
}

module.exports = { resolvePricing, calculateCost, BUILTIN, CACHE_CREATION_MULTIPLIER, CACHE_READ_MULTIPLIER };
