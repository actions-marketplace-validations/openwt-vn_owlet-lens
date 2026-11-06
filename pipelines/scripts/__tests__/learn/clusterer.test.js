// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { clusterPatterns } = require('../../lib/learn/clusterer.js');

function fakeLLM(text) {
  return { supportsTools: false, async call() { return { text, usage: {}, cost: {} }; } };
}

describe('clusterPatterns', () => {
  const items = [
    { category: 'style', findingBody: 'a', devReply: 'r1' },
    { category: 'style', findingBody: 'b', devReply: 'r2' },
  ];

  it('parses clusters from JSON response', async () => {
    const text = JSON.stringify({ clusters: [
      { rule: 'Allow trailing commas', rationale: 'team prefers', category: 'style', itemIndexes: [0, 1] },
    ] });
    const out = await clusterPatterns(items, { llmProvider: fakeLLM(text), model: 'm' });
    assert.equal(out.clusters.length, 1);
    assert.deepEqual(out.clusters[0].itemIndexes, [0, 1]);
    assert.equal(out.clusters[0].category, 'style');
  });

  it('returns [] for empty items without calling the LLM', async () => {
    let called = false;
    const llm = { async call() { called = true; return { text: '{}' }; } };
    const out = await clusterPatterns([], { llmProvider: llm, model: 'm' });
    assert.deepEqual(out.clusters, []);
    assert.equal(called, false);
  });

  // --- #86: the learn payload runs through the SEC-4 diff redactor ---
  it('redacts a secret quoted in a dev reply before clustering', async () => {
    let captured = null;
    const llm = { async call(_s, u) { captured = u; return { text: '{"clusters":[]}' }; } };
    await clusterPatterns(
      [{ category: 'security', findingBody: 'hardcoded credential', devReply: 'url is postgres://app:s3cretpass@db/prod' }],
      { llmProvider: llm, model: 'm' },
    );
    assert.ok(!captured.includes('s3cretpass'), 'password survived into the learn prompt');
    assert.ok(captured.includes('[REDACTED]'));
  });

  it('redacts a token pasted in a finding body', async () => {
    let captured = null;
    const llm = { async call(_s, u) { captured = u; return { text: '{"clusters":[]}' }; } };
    await clusterPatterns(
      [{ category: 'security', findingBody: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 committed", devReply: 'will rotate' }],
      { llmProvider: llm, model: 'm' },
    );
    assert.ok(!captured.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  });

  it('still clusters from redacted prompts', async () => {
    const text = JSON.stringify({ clusters: [
      { rule: 'No inline credentials', rationale: 'dev quoted the url', category: 'security', itemIndexes: [0, 1] },
    ] });
    let captured = null;
    const llm = { async call(_s, u) { captured = u; return { text }; } };
    const out = await clusterPatterns([
      { category: 'security', findingBody: 'a: password = "hunter2hunter2hunter2"', devReply: 'r1' },
      { category: 'security', findingBody: 'b', devReply: 'r2' },
    ], { llmProvider: llm, model: 'm' });
    assert.ok(captured.includes('[REDACTED]'));
    assert.equal(out.clusters.length, 1);
    assert.deepEqual(out.clusters[0].itemIndexes, [0, 1]);
  });

  it('coerces string itemIndexes from JSON-mode providers', async () => {
    const text = JSON.stringify({ clusters: [
      { rule: 'r', rationale: 'x', category: 'style', itemIndexes: ['0', '1'] },
    ] });
    const out = await clusterPatterns(items, { llmProvider: fakeLLM(text), model: 'm' });
    assert.equal(out.clusters.length, 1);
    assert.deepEqual(out.clusters[0].itemIndexes, [0, 1]);
  });

  it('requests native JSON mode (responseFormat:json) from the provider', async () => {
    let seenOpts;
    const llm = { async call(_s, _u, opts) { seenOpts = opts; return { text: '{"clusters":[]}' }; } };
    await clusterPatterns(items, { llmProvider: llm, model: 'm' });
    assert.equal(seenOpts.responseFormat, 'json');
  });

  it('drops clusters with out-of-range or empty indexes', async () => {
    const text = JSON.stringify({ clusters: [
      { rule: 'ok', rationale: 'r', category: 'style', itemIndexes: [0] },
      { rule: 'bad', rationale: 'r', category: 'style', itemIndexes: [99] },
      { rule: 'empty', rationale: 'r', category: 'style', itemIndexes: [] },
    ] });
    const out = await clusterPatterns(items, { llmProvider: fakeLLM(text), model: 'm' });
    assert.equal(out.clusters.length, 1);
    assert.equal(out.clusters[0].rule, 'ok');
  });
});
