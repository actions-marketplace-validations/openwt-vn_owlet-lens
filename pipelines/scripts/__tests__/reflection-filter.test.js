// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reflectionFilter, __test__ } = require('../lib/reflection-filter.js');
const { buildReflectionPrompt, parseReflectionResponse, chunkFindings } = __test__;

// -- helpers ------------------------------------------------------------------

function makeFinding(overrides = {}) {
  return {
    filePath: 'src/app.js', line: 10, body: 'Unused variable', severity: 'MEDIUM',
    category: 'style', suggestion: null, ruleId: 'style', ...overrides,
  };
}

function makeDiff(filePath = 'src/app.js', patch = '+const x = 1;') {
  return { path: filePath, patch, annotatedDiff: `10:+ ${patch}` };
}

function fakeLLM(responseText) {
  return {
    call: async () => ({
      text: typeof responseText === 'function' ? responseText() : responseText,
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: { totalCost: 0.001 },
    }),
  };
}

function failingLLM(err) {
  return {
    call: async () => { throw err ?? new Error('LLM down'); },
  };
}

// -- chunkFindings ------------------------------------------------------------

describe('chunkFindings', () => {
  it('returns single chunk for ≤20 findings', () => {
    const findings = Array.from({ length: 20 }, (_, i) => makeFinding({ line: i + 1 }));
    const chunks = chunkFindings(findings);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 20);
  });

  it('splits >20 findings into balanced ~15-sized chunks', () => {
    const findings = Array.from({ length: 35 }, (_, i) => makeFinding({ line: i + 1 }));
    const chunks = chunkFindings(findings);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) assert.ok(chunk.length <= 20);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    assert.equal(total, 35);
  });

  it('returns single chunk for 1 finding', () => {
    const chunks = chunkFindings([makeFinding()]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });
});

// -- parseReflectionResponse --------------------------------------------------

describe('parseReflectionResponse', () => {
  it('parses valid response with all verdicts', () => {
    const json = JSON.stringify({
      verdicts: [
        { index: 0, verdict: 'keep', reason: 'valid issue' },
        { index: 1, verdict: 'drop', reason: 'hallucinated behavior' },
      ],
    });
    const result = parseReflectionResponse(json, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].verdict, 'keep');
    assert.equal(result[1].verdict, 'drop');
  });

  it('defaults missing indices to keep (fail-open)', () => {
    const json = JSON.stringify({
      verdicts: [{ index: 0, verdict: 'drop', reason: 'bad' }],
    });
    const result = parseReflectionResponse(json, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0].verdict, 'drop');
    assert.equal(result[1].verdict, 'keep');
    assert.equal(result[2].verdict, 'keep');
    assert.ok(result[1].reason.includes('no verdict'));
  });

  it('returns all-keep on unparseable JSON (fail-open)', () => {
    const result = parseReflectionResponse('not json at all', 2);
    assert.equal(result.length, 2);
    assert.ok(result.every((v) => v.verdict === 'keep'));
  });

  it('normalizes invalid verdict values to keep', () => {
    const json = JSON.stringify({
      verdicts: [{ index: 0, verdict: 'maybe', reason: 'unsure' }],
    });
    const result = parseReflectionResponse(json, 1);
    assert.equal(result[0].verdict, 'keep');
  });
});

// -- buildReflectionPrompt ----------------------------------------------------

describe('buildReflectionPrompt', () => {
  it('includes findings and diff context', () => {
    const findings = [makeFinding()];
    const diffs = [makeDiff()];
    const { systemPrompt, userPrompt } = buildReflectionPrompt(findings, diffs, 'use strict;');
    assert.ok(systemPrompt.includes('skeptical senior engineer'));
    assert.ok(userPrompt.includes('Unused variable'));
    assert.ok(userPrompt.includes('src/app.js'));
  });

  it('includes coding standards in system prompt', () => {
    const { systemPrompt } = buildReflectionPrompt([makeFinding()], [makeDiff()], 'no console.log');
    assert.ok(systemPrompt.includes('no console.log'));
  });

  it('handles findings with no matching diff', () => {
    const findings = [makeFinding({ filePath: 'missing.js' })];
    const diffs = [makeDiff('other.js')];
    const { userPrompt } = buildReflectionPrompt(findings, diffs, '');
    assert.ok(userPrompt.includes('missing.js'));
    assert.ok(userPrompt.includes('(no diff available)'));
  });
});

// -- reflectionFilter (integration) -------------------------------------------

describe('reflectionFilter', () => {
  it('keeps findings the reflector says keep', async () => {
    const findings = [makeFinding()];
    const diffs = [makeDiff()];
    const llm = fakeLLM(JSON.stringify({
      verdicts: [{ index: 0, verdict: 'keep', reason: 'real issue' }],
    }));
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
  });

  it('drops findings the reflector says drop', async () => {
    const findings = [makeFinding(), makeFinding({ line: 20, body: 'Hallucinated' })];
    const diffs = [makeDiff()];
    const llm = fakeLLM(JSON.stringify({
      verdicts: [
        { index: 0, verdict: 'keep', reason: 'valid' },
        { index: 1, verdict: 'drop', reason: 'function does not exist in diff' },
      ],
    }));
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].dropReason, 'function does not exist in diff');
    assert.equal(result.log.total, 2);
    assert.equal(result.log.kept, 1);
    assert.equal(result.log.dropped, 1);
  });

  it('fail-open: keeps all findings when LLM call fails', async () => {
    const findings = [makeFinding(), makeFinding({ line: 20 })];
    const diffs = [makeDiff()];
    const llm = failingLLM();
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 2);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.log.failed, 1);
  });

  it('fail-open: keeps findings with unparseable response', async () => {
    const findings = [makeFinding()];
    const diffs = [makeDiff()];
    const llm = fakeLLM('this is not json');
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
  });

  it('tracks cost across chunked batches', async () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ line: i + 1 }));
    const diffs = [makeDiff()];
    const llm = {
      call: async (_sys, usr) => {
        const match = usr.match(/Finding (\d+)\/\d+/g);
        const count = match ? match.length : 0;
        return {
          text: JSON.stringify({
            verdicts: Array.from({ length: count }, (_, i) => ({
              index: i, verdict: 'keep', reason: 'ok',
            })),
          }),
          usage: { inputTokens: 100, outputTokens: 50 },
          cost: { totalCost: 0.001 },
        };
      },
    };
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 25);
    assert.ok(result.cost.totalCost > 0.001, 'should accumulate cost from multiple chunks');
  });

  it('records each answering model and tokens in usage across chunks', async () => {
    // 25 findings span 2 chunks; the reply provider "fails over" for the
    // second chunk so the two calls are answered by different models. Both
    // must land in usage the way the review path records them.
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ line: i + 1 }));
    const diffs = [makeDiff()];
    let calls = 0;
    const llm = {
      call: async (_sys, usr) => {
        calls += 1;
        const match = usr.match(/Finding (\d+)\/\d+/g);
        const count = match ? match.length : 0;
        return {
          text: JSON.stringify({
            verdicts: Array.from({ length: count }, (_, i) => ({ index: i, verdict: 'keep', reason: 'ok' })),
          }),
          usage: { inputTokens: 100, outputTokens: 50 },
          cost: { totalCost: 0.001 },
          model: calls === 1 ? 'primary-reply' : 'fallback-reply',
        };
      },
    };
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.ok(calls >= 2, '25 findings must span multiple reflection chunks');
    assert.equal(result.usage.inputTokens, calls * 100);
    assert.equal(result.usage.outputTokens, calls * 50);
    assert.equal(result.usage.cost, calls * 0.001);
    assert.deepEqual(result.usage.models, ['primary-reply', 'fallback-reply']);
  });

  it('exposes zeroed usage when llmProvider omits model', async () => {
    const findings = [makeFinding()];
    const diffs = [makeDiff()];
    const llm = fakeLLM(JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: 'ok' }] }));
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 50);
    assert.equal(result.usage.cost, 0.001);
    assert.deepEqual(result.usage.models, [], 'no response.model → no model to attribute');
  });

  it('returns empty result for empty findings', async () => {
    const llm = fakeLLM('{}');
    const result = await reflectionFilter({ findings: [], diffs: [], codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.cost.totalCost, 0);
  });

  it('handles partial parse — keeps findings without verdicts', async () => {
    const findings = [makeFinding(), makeFinding({ line: 20 }), makeFinding({ line: 30 })];
    const diffs = [makeDiff()];
    const llm = fakeLLM(JSON.stringify({
      verdicts: [{ index: 0, verdict: 'drop', reason: 'bad' }],
    }));
    const result = await reflectionFilter({ findings, diffs, codingStandards: '', llmProvider: llm });
    assert.equal(result.kept.length, 2);
    assert.equal(result.dropped.length, 1);
  });
});
