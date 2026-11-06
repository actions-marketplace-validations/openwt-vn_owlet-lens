// @ts-check
'use strict';

const { safeMsg } = require('./log-safe.js');
const { extractJson } = require('./json-extract.js');

const REFLECTION_SYSTEM_PROMPT = `You are a skeptical senior engineer reviewing AI-generated code review findings.

For each finding, determine whether it is factually correct and actionable given the actual code in the diff. Challenge each finding:
- Does the code actually do what the finding claims?
- Is the suggested fix relevant to the actual code?
- Is the issue actionable, not just a theoretical concern?

Drop anything hallucinated, factually wrong, or not actionable. When in doubt, KEEP the finding — false negatives are worse than false positives.

You receive: a numbered list of findings, each with its file's diff context.

Return JSON: { "verdicts": [{ "index": <0-based>, "verdict": "keep" | "drop", "reason": "<one short sentence>" }] }

Return a verdict for EVERY finding index. Output ONLY the JSON object. No prose, no markdown fences.`;

/**
 * Split findings into chunks of ~15 when >20, single chunk otherwise.
 * @param {any[]} findings
 * @returns {any[][]}
 */
function chunkFindings(findings) {
  if (findings.length <= 20) return [findings];
  const chunkSize = 15;
  const chunks = [];
  for (let i = 0; i < findings.length; i += chunkSize) {
    chunks.push(findings.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * @param {any[]} findings
 * @param {any[]} diffs
 * @param {string} codingStandards
 */
function buildReflectionPrompt(findings, diffs, codingStandards) {
  const diffByFile = new Map(diffs.map((d) => [d.path, d.annotatedDiff ?? d.patch ?? '']));

  let systemPrompt = REFLECTION_SYSTEM_PROMPT;
  if (codingStandards) {
    systemPrompt = `=== PROJECT CODING STANDARDS (reference only) ===\n${codingStandards}\n=== END CODING STANDARDS ===\n\n${systemPrompt}`;
  }

  const parts = [];
  findings.forEach((f, i) => {
    const diff = diffByFile.get(f.filePath) ?? '(no diff available)';
    parts.push(
      `--- Finding ${i + 1}/${findings.length} ---\n` +
      `File: ${f.filePath}\nLine: ${f.line}\nSeverity: ${f.severity}\nCategory: ${f.category}\n` +
      `Message: ${f.body}\n` +
      (f.suggestion ? `Suggestion: ${f.suggestion}\n` : '') +
      `\nDiff context:\n\`\`\`\n${diff}\n\`\`\``
    );
  });

  return { systemPrompt, userPrompt: parts.join('\n\n') };
}

/**
 * Parse the reflection LLM response. Fail-open: missing/invalid verdicts default to keep.
 * @param {string} text
 * @param {number} findingCount
 * @returns {Array<{ verdict: 'keep'|'drop', reason: string }>}
 */
function parseReflectionResponse(text, findingCount) {
  const fallback = () => Array.from({ length: findingCount }, () => ({
    verdict: /** @type {'keep'} */ ('keep'),
    reason: '(no verdict returned — fail-open)',
  }));

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.verdicts)) return fallback();

  /** @type {Map<number, { verdict: string, reason: string }>} */
  const byIndex = new Map();
  for (const v of parsed.verdicts) {
    if (typeof v.index === 'number' && (v.verdict === 'keep' || v.verdict === 'drop')) {
      byIndex.set(v.index, { verdict: v.verdict, reason: safeMsg({ message: String(v.reason ?? '') }).slice(0, 500) });
    }
  }

  return Array.from({ length: findingCount }, (_, i) => {
    const entry = byIndex.get(i);
    if (entry) return entry;
    return { verdict: /** @type {'keep'} */ ('keep'), reason: '(no verdict for this index — fail-open)' };
  });
}

/** @param {string} msg @param {Record<string,any>} [fields] */
function logStderr(msg, fields = {}) {
  process.stderr.write(JSON.stringify({ level: 'info', msg, ts: new Date().toISOString(), ...fields }) + '\n');
}

/**
 * @param {{
 *   findings: any[],
 *   diffs: any[],
 *   codingStandards: string,
 *   llmProvider: { call: Function },
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} opts
 */
async function reflectionFilter({ findings, diffs, codingStandards, llmProvider, log }) {
  const _log = log ?? ((level, msg, fields) => logStderr(msg, { level, ...fields }));

  if (findings.length === 0) {
    return {
      kept: [], dropped: [],
      cost: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, models: [] },
      log: { total: 0, kept: 0, dropped: 0, failed: 0 },
    };
  }

  _log('info', 'reflection.start', { total: findings.length });

  const chunks = chunkFindings(findings);
  const allVerdicts = [];
  let totalInputTokens = 0, totalOutputTokens = 0, totalCost = 0;
  /** @type {string[]} */
  const models = [];
  let failedChunks = 0;

  for (const chunk of chunks) {
    const globalOffset = allVerdicts.length;
    try {
      const { systemPrompt, userPrompt } = buildReflectionPrompt(chunk, diffs, codingStandards);
      const response = await llmProvider.call(systemPrompt, userPrompt, { maxTokens: 4000 });
      totalInputTokens += response.usage?.inputTokens ?? 0;
      totalOutputTokens += response.usage?.outputTokens ?? 0;
      totalCost += response.cost?.totalCost ?? 0;
      // Under model-failover the reply model that answered can differ from the
      // configured primary; attribute it the same way the review path does.
      const answeredModel = typeof response?.model === 'string' && response.model.trim()
        ? response.model
        : null;
      if (answeredModel && !models.includes(answeredModel)) models.push(answeredModel);
      const verdicts = parseReflectionResponse(response.text ?? '', chunk.length);
      allVerdicts.push(...verdicts);
    } catch (e) {
      failedChunks++;
      _log('warn', 'reflection.chunk.failed', { chunkSize: chunk.length, errName: e?.name, errMessage: safeMsg(e) });
      for (let i = 0; i < chunk.length; i++) {
        allVerdicts.push({ verdict: 'keep', reason: '(reflection call failed — fail-open)' });
      }
    }
  }

  const kept = [];
  const dropped = [];
  for (let i = 0; i < findings.length; i++) {
    const v = allVerdicts[i];
    if (v.verdict === 'drop') {
      dropped.push({ ...findings[i], dropReason: v.reason });
      _log('info', 'finding.dropped.reflection', {
        file: findings[i].filePath, line: findings[i].line,
        severity: findings[i].severity, category: findings[i].category,
        reason: v.reason,
      });
    } else {
      kept.push(findings[i]);
    }
  }

  _log('info', 'reflection.summary', {
    total: findings.length, kept: kept.length, dropped: dropped.length, failed: failedChunks,
  });

  return {
    kept,
    dropped,
    cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalCost },
    // Same shape as the review path's per-call usage (review-pass.js addUsage)
    // so callers can merge reflection spend into the run totals wholesale.
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost: totalCost, models },
    log: { total: findings.length, kept: kept.length, dropped: dropped.length, failed: failedChunks },
  };
}

module.exports = {
  reflectionFilter,
  __test__: { buildReflectionPrompt, parseReflectionResponse, chunkFindings },
};
