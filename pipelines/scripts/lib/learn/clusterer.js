// @ts-check
'use strict';

const { LLMError } = require('../errors.js');
const { extractJson } = require('../json-extract.js');
const { redactDiffSecrets } = require('../diff-secret-redact.js');

const SYSTEM = `You analyze code-review findings that developers rejected (wontfix).
Group them into recurring CONVENTION patterns the team evidently follows.
A cluster is only valid if its items share a genuine common rule — do NOT force unrelated items together.
Respond ONLY with JSON: { "clusters": [ { "rule": "imperative one-line standard", "rationale": "why, from dev replies", "category": "<one of the input categories>", "itemIndexes": [int,...] } ] }
Each itemIndex refers to an input item's position. Omit clusters of size < 2.`;

/** Extract the first balanced top-level JSON object and return its clusters array. */
function parseClusters(text) {
  const obj = extractJson(text);
  return obj && Array.isArray(obj.clusters) ? obj.clusters : [];
}

/**
 * @param {Array<{category:string,findingBody:string,devReply:string}>} items
 * @param {{ llmProvider: any, model: string }} opts
 * @returns {Promise<{
 *   clusters: Array<{ rule: string, rationale: string, category: string, itemIndexes: number[] }>,
 *   usage: { inputTokens: number, outputTokens: number, cost: number, models: string[] },
 * }>}
 */
async function clusterPatterns(items, { llmProvider, model }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { clusters: [], usage: { inputTokens: 0, outputTokens: 0, cost: 0, models: [] } };
  }
  // Finding bodies and dev replies are harvested from real PR threads and can
  // quote a credential verbatim (a dev reply often pastes the offending line).
  // Run the same SEC-4 redactor the review path uses over the assembled prompt.
  const { redacted: user, count } = redactDiffSecrets(
    `Findings (index: [category] finding -> devReply):\n` +
      items.map((it, i) => `${i}: [${it.category}] ${it.findingBody} -> ${it.devReply}`).join('\n'),
  );
  if (count > 0) {
    process.stderr.write(JSON.stringify({
      level: 'warn', msg: 'learn.secrets.redacted', count,
    }) + '\n');
  }

  let text;
  let usage = { inputTokens: 0, outputTokens: 0, cost: 0, models: [] };
  try {
    // Ask providers that support it (DeepSeek) for native JSON mode, mirroring
    // the reply evaluator — without it DeepSeek may wrap the clusters in prose
    // and parseClusters returns [] (no proposal despite real signal).
    const res = await llmProvider.call(SYSTEM, user, { model, responseFormat: 'json' });
    text = String(res?.text ?? '');
    // Clustering spend must reach the run totals: tokens, cost, and the model
    // that answered (which failover can differ from the configured primary).
    const answeredModel = typeof res?.model === 'string' && res.model.trim()
      ? res.model
      : (typeof model === 'string' ? model : null);
    usage = {
      inputTokens: res?.usage?.inputTokens ?? 0,
      outputTokens: res?.usage?.outputTokens ?? 0,
      cost: res?.cost?.totalCost ?? 0,
      models: answeredModel ? [answeredModel] : [],
    };
  } catch (e) {
    throw new LLMError(`learn clustering failed: ${e?.message ?? e}`);
  }

  const raw = parseClusters(text);
  const out = [];
  for (const c of raw) {
    // Coerce first: JSON-mode providers sometimes emit indexes as strings
    // ("0","1"); Number.isInteger("0") is false, which would silently drop the
    // whole cluster.
    const idx = Array.isArray(c.itemIndexes)
      ? c.itemIndexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < items.length)
      : [];
    if (idx.length === 0 || typeof c.rule !== 'string' || !c.rule.trim()) continue;
    out.push({
      rule: c.rule.trim(),
      rationale: typeof c.rationale === 'string' ? c.rationale.trim() : '',
      category: typeof c.category === 'string' ? c.category.toLowerCase() : (items[idx[0]].category),
      itemIndexes: [...new Set(idx)],
    });
  }
  return { clusters: out, usage };
}

module.exports = { clusterPatterns, parseClusters };
