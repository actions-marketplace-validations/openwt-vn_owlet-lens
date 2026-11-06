// @ts-check
'use strict';

// The `learn` subcommand: mine wontfix verdicts from merged PRs, ask the LLM
// to cluster them, and propose coding-standards rules via a PR. Split out of
// ai-review.js so the entrypoint stays a thin dispatcher. See CLAUDE.md
// (Self-learning) and docs/config.md#self-learning-reviewlearn.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config-loader.js');
const providerIndex = require('../providers/index.js');
const { detectProvider } = providerIndex;
const llmIndex = require('../llm/index.js');
const learnPort = require('../port/learn-port.js');
const { parseArgs } = require('../args.js');
const { runLifecycle } = require('../run-lifecycle.js');
const { safeMsg } = require('../log-safe.js');
const { logEvent } = require('../log-helpers.js');
const { ConfigError } = require('../errors.js');

/**
 * Testable learn core. Decides dry-run vs propose and returns an exit code.
 *
 * @param {{
 *   provider: any, cfgLearn: any, dryRun: boolean, buildProposal: Function,
 *   readStandards: Function, baseBranch: string, standardsPath: string,
 *   nowISO: string, llmProvider: any, model?: string, ignoreText?: string,
 *   recordUsage?: (spend: { costUsd: number, model: string, inputTokens: number, outputTokens: number }) => void,
 * }} opts
 * @returns {Promise<number>}
 */
async function runLearnWith({
  provider, cfgLearn, dryRun, buildProposal, readStandards,
  baseBranch, standardsPath, nowISO, llmProvider, model, ignoreText = '',
  recordUsage = null,
}) {
  if (!provider.capabilities?.canProposeChanges) {
    logEvent('warn', 'learn.unsupported-provider', { hint: 'provider cannot propose changes; skipping' });
    return 0;
  }
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(nowMs)) throw new ConfigError(`learn: invalid nowISO timestamp: ${nowISO}`);
  const since = new Date(nowMs - cfgLearn.lookbackDays * 86400000).toISOString();
  const proposal = await buildProposal({
    provider, llmProvider, model, cfgLearn, sinceISO: since,
    standardsText: readStandards(), ignoreText,
  });

  // Surface clustering spend whether or not a proposal survives the
  // threshold/dedup stages — an LLM that clustered and found nothing novel
  // still cost money that has to be recorded.
  const usage = proposal?.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0, models: [] };
  const spend = {
    costUsd: Number.isFinite(usage.cost) ? usage.cost : 0,
    model: usage.models && usage.models.length > 0
      ? usage.models.join(',')
      : (typeof model === 'string' && model.trim() ? model : ''),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  if (typeof recordUsage === 'function') recordUsage(spend);

  if (!proposal || !proposal.rules) {
    logEvent('info', 'learn.no-proposal', {});
    process.stdout.write(JSON.stringify({ proposed: false, ...spend }) + '\n');
    return 0;
  }
  if (dryRun) {
    logEvent('info', 'learn.dry-run', { ruleCount: proposal.rules.length });
    process.stdout.write(proposal.newContent + '\n');
    return 0;
  }
  const branch = `${cfgLearn.branchPrefix}-${nowISO.slice(0, 10)}`;
  const { url } = await provider.proposeStandardsChange({
    branch, filePath: standardsPath, newContent: proposal.newContent,
    baseBranch, title: `chore(standards): learned conventions (${proposal.rules.length})`,
    body: learnPrBody(proposal.rules),
  });
  logEvent('info', 'learn.proposed', { url, ruleCount: proposal.rules.length });
  process.stdout.write(JSON.stringify({ proposed: true, url, ruleCount: proposal.rules.length, ...spend }) + '\n');
  return 1;
}

/** @param {Array<{category:string,rule:string,rationale:string,evidencePrs:string[]}>} rules */
function learnPrBody(rules) {
  // Render one row per learned rule. Escape pipes and flatten newlines so a
  // rule/rationale containing them can't break the Markdown table.
  const cell = (s) => String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
  const lines = [
    'Auto-proposed coding-standards updates learned from developer `wontfix` feedback.',
    '',
    'Review each rule — merge to adopt, close to reject.',
    '',
    '| # | Category | Rule | Why | Evidence |',
    '|---|----------|------|-----|----------|',
  ];
  rules.forEach((r, i) => {
    const prs = (r.evidencePrs || []).map((p) => `#${p}`).join(', ');
    lines.push(`| ${i + 1} | ${cell(r.category)} | ${cell(r.rule)} | ${cell(r.rationale)} | ${cell(prs)} |`);
  });
  return lines.join('\n');
}

async function runLearn({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  return runLifecycle({ env }, async (life) => {
    const cliFlags = parseArgs(argv);
    const config = loadConfig({ cwd, env, cliFlags });
    const providerName = detectProvider({ env, cliFlag: cliFlags.provider, configValue: config.provider });
    const provider = providerIndex.makeProvider(providerName, { config, env, requirePr: false });

    const llmName = llmIndex.detectLLMProvider({ env, configValue: config.review.provider, kind: 'review' });
    const llmProvider = llmIndex.makeLLMProvider(llmName, { config, kind: 'review' });

    const standardsPath = config.review.codingStandardsPath;
    if (typeof standardsPath !== 'string' || standardsPath.trim() === '') {
      throw new ConfigError('learn requires review.codingStandardsPath to be set');
    }
    const absStandards = path.isAbsolute(standardsPath) ? standardsPath : path.join(cwd, standardsPath);
    let standardsText;
    try {
      standardsText = fs.readFileSync(absStandards, 'utf8');
    } catch (e) {
      throw new ConfigError(`cannot read codingStandardsPath '${standardsPath}': ${safeMsg(e)}`);
    }
    const readStandards = () => standardsText;

    let ignoreText = '';
    const ignorePath = config.review.learn.ignorePath;
    if (ignorePath) {
      try {
        ignoreText = fs.readFileSync(path.isAbsolute(ignorePath) ? ignorePath : path.join(cwd, ignorePath), 'utf8');
      } catch { /* optional file */ }
    }

    // Prefer the explicit config; otherwise fall back to the repository's real
    // default branch (queried from the provider) instead of guessing 'develop'.
    const baseBranch = config.review.learn.baseBranch ?? await provider.getDefaultBranch();

    return await runLearnWith({
      provider, cfgLearn: config.review.learn, dryRun: cliFlags.dryRun === true,
      buildProposal: learnPort.buildProposal, readStandards,
      baseBranch, standardsPath, nowISO: new Date().toISOString(),
      llmProvider, model: config.review.model, ignoreText,
      // Learn spend reaches the audit log the same way review/reply do. The
      // cumulative state ledger stays review/reply-only — widening it is
      // deliberately out of scope (issue #89).
      recordUsage: (spend) => life.writeAudit({
        path: config.review.auditLogPath,
        enabled: !cliFlags.dryRun,
        repo: provider.repoSlug ?? null,
        entry: { event: 'learn', ...spend },
      }),
    });
  });
}

module.exports = { runLearn, runLearnWith, learnPrBody };
