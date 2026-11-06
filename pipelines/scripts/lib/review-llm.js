// @ts-check
'use strict';

// Review-path LLM call: one request with structured output when the provider
// supports tools, JSON extraction from the response text, and one stricter
// re-prompt when the response does not parse. Private to the review pass.

const { CONFIG } = require('./config.js');
const { safeMsg, safeCause, redactSecrets } = require('./log-safe.js');
const { LLMError, isLLMTransportError } = require('./errors.js');
const { extractJson } = require('./json-extract.js');

// Anthropic tool-use spec for the review path. Forces a JSON-schema-conformant
// `submit_findings` invocation so the response never needs free-text JSON
// extraction. Schema mirrors the prompt's documented contract.
const SUBMIT_FINDINGS_TOOL = Object.freeze({
  name: 'submit_findings',
  description: 'Submit the structured list of code review findings.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Brief overall assessment (1-2 sentences).' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
            category: { type: 'string', enum: ['security', 'bug', 'performance', 'naming', 'architecture', 'style'] },
            message: { type: 'string' },
            suggestion: { type: 'string', description: 'Replacement code for a simple one-line fix. Omit if the fix is complex or structural.' },
          },
          required: ['file', 'line', 'severity', 'category', 'message'],
        },
      },
    },
    required: ['findings'],
  },
});

const STRICTER_SUFFIX = "\n\nIMPORTANT: respond with ONLY a single JSON object matching the schema. No prose, no markdown fences. Output must start with '{' and end with '}'.";

/**
 * @typedef {(level: string, msg: string, fields?: object) => void} LogFn
 * @typedef {{ llm: any, model: string, providerName: string, log: LogFn }} CallCtx
 */

/** @param {string} text */
function snippet(text, head = 400, tail = 400) {
  const safe = redactSecrets(text);
  if (safe.length <= head + tail) return { head: safe, tail: '' };
  return { head: safe.slice(0, head), tail: safe.slice(-tail) };
}

/**
 * One LLM call. Transport errors propagate unchanged (so the orchestrator
 * maps them to their own exit codes); anything else becomes LLMError.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {CallCtx} ctx
 * @param {number} attempt
 */
async function callOnce(systemPrompt, userPrompt, ctx, attempt) {
  const { llm, model, providerName: provider, log } = ctx;
  const useTools = llm.supportsTools === true;
  log('info', 'llm.call.start', {
    provider, model, attempt,
    sysPromptLen: systemPrompt.length,
    userPromptLen: userPrompt.length,
    structuredOutput: useTools,
  });
  let response;
  const t0 = Date.now();
  try {
    response = await llm.call(systemPrompt, userPrompt, {
      model,
      maxTokens: CONFIG.reviewMaxTokens,
      ...(useTools ? {
        tools: [SUBMIT_FINDINGS_TOOL],
        toolChoice: { type: 'tool', name: SUBMIT_FINDINGS_TOOL.name },
      } : {}),
    });
  } catch (/** @type {any} */ e) {
    const status = typeof e?.status === 'number' ? e.status : null;
    const cause = safeCause(e);
    log('error', 'llm.call.failed', {
      provider, model, attempt,
      durationMs: Date.now() - t0,
      errName: e?.name, errStatus: status, errMessage: safeMsg(e), ...cause,
    });
    if (isLLMTransportError(e)) throw e;
    const statusLabel = status ?? 'unknown';
    const causeDetail = cause.errCode ? ` [${cause.errCode}]` : '';
    const detail = e?.message ? `: ${safeMsg(e)}${causeDetail}` : '';
    throw new LLMError(`LLM call failed (status ${statusLabel})${detail}`);
  }
  const text = response?.text ?? '';
  const usage = response?.usage ?? null;
  const cost = response?.cost ?? null;
  // Under model-failover the model that answered may differ from the configured
  // primary; attribute success/cost logs to the model that actually ran.
  const answeredModel = response?.model ?? model;
  log('info', 'llm.call.success', {
    provider, model: answeredModel, attempt,
    durationMs: Date.now() - t0,
    textLen: text.length,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
    costUsd: cost?.totalCost ?? null,
  });
  if (cost && cost.priced === false) {
    log('warn', 'llm.cost.unpriced', {
      provider, model: answeredModel,
      msg: 'no pricing table entry for model; cost reported as $0 — add it under pricing: in config for accurate totals',
    });
  }
  return { text, usage, cost, model: answeredModel };
}

/**
 * A findings envelope is any parsed object carrying a `findings` array. The
 * shared scanner returns the first JSON object satisfying this, so a stray
 * non-findings object (or malformed braces) ahead of the real payload is
 * skipped rather than accepted.
 *
 * @param {any} obj
 * @returns {boolean}
 */
function isFindingsEnvelope(obj) {
  return Boolean(obj) && typeof obj === 'object' && Array.isArray(obj.findings);
}

/**
 * Call once; if the response has no parseable findings object, re-prompt
 * once with a stricter instruction. Returns every call's usage so the caller
 * can account for both attempts.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {CallCtx} ctx
 * @returns {Promise<{ parsed: { findings: any[] } | null, calls: Array<{ usage: any, cost: any, model: string }> }>}
 */
async function callForFindings(systemPrompt, userPrompt, ctx) {
  const first = await callOnce(systemPrompt, userPrompt, ctx, 1);
  const calls = [first];
  let parsed = extractJson(first.text, isFindingsEnvelope);
  if (parsed) return { parsed, calls };

  const snip = snippet(first.text);
  ctx.log('warn', 'llm.extract.failed', {
    provider: ctx.providerName, model: ctx.model, attempt: 1,
    textLen: first.text.length, head: snip.head, tail: snip.tail,
  });
  ctx.log('info', 'llm.retry.stricter', { provider: ctx.providerName, model: ctx.model });
  const second = await callOnce(systemPrompt + STRICTER_SUFFIX, userPrompt, ctx, 2);
  calls.push(second);
  parsed = extractJson(second.text, isFindingsEnvelope);
  if (!parsed) {
    const snip2 = snippet(second.text);
    ctx.log('error', 'llm.extract.failed.final', {
      provider: ctx.providerName, model: ctx.model, attempt: 2,
      textLen: second.text.length, head: snip2.head, tail: snip2.tail,
    });
  }
  return { parsed, calls };
}

module.exports = { callForFindings, SUBMIT_FINDINGS_TOOL };
