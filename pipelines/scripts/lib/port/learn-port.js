// @ts-check
'use strict';

const harvester = require('../learn/harvester.js');
const clusterer = require('../learn/clusterer.js');
const { applyThreshold } = require('../learn/threshold.js');
const { filterNovel } = require('../learn/dedup.js');
const {
  extractLearnedBlock, parseRuleFingerprints, parseLearnedRules,
  parseIgnoreFingerprints, spliceLearnedBlock,
} = require('./learn-helpers.js');
const { logInfo } = require('../log-helpers.js');

/**
 * Pure orchestration. `deps` lets tests inject fakes for the harvest/cluster steps.
 *
 * @param {{
 *   provider: any, llmProvider: any, model: string,
 *   cfgLearn: { lookbackDays?: number, minWontfix: number, minDistinctAuthors: number, maxPrs?: number },
 *   sinceISO?: string,
 *   standardsText: string, ignoreText: string,
 *   deps?: { harvestWontfix?: Function, clusterPatterns?: Function },
 * }} args
 * @returns {Promise<{
 *   rules: Array<{category:string,rule:string,rationale:string,evidencePrs:string[]}> | null,
 *   newContent: string | null,
 *   usage: { inputTokens: number, outputTokens: number, cost: number, models: string[] },
 * }>} `rules: null` when nothing is worth proposing (usage still reports any
 * clustering spend that happened before the gate)
 */
async function buildProposal(args) {
  const {
    provider, llmProvider, model, cfgLearn, sinceISO,
    standardsText, ignoreText, deps = {},
  } = args;
  const harvestFn = deps.harvestWontfix ?? harvester.harvestWontfix;
  const clusterFn = deps.clusterPatterns ?? clusterer.clusterPatterns;
  const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cost: 0, models: [] };

  const items = await harvestFn(provider, {
    sinceISO: sinceISO ?? '', limit: cfgLearn.maxPrs ?? 200,
  });
  if (items.length === 0) { logInfo('learn.pipeline', { stage: 'harvest', items: 0, result: 'no-proposal' }); return { rules: null, newContent: null, usage: ZERO_USAGE }; }

  // Real clusterer returns { clusters, usage }. Test deps may still return the
  // bare array; both are accepted.
  const clustered = await clusterFn(items, { llmProvider, model });
  const clusters = Array.isArray(clustered) ? clustered : (clustered?.clusters ?? []);
  const usage = !Array.isArray(clustered) && clustered?.usage ? clustered.usage : ZERO_USAGE;
  logInfo('learn.pipeline', { stage: 'cluster', items: items.length, clusters: clusters.length });
  if (clusters.length === 0) { logInfo('learn.pipeline', { stage: 'cluster', result: 'no-proposal' }); return { rules: null, newContent: null, usage }; }

  // Counts computed deterministically from harvested items — never trust the LLM.
  const enriched = clusters.map((c) => {
    const its = c.itemIndexes.map((i) => items[i]);
    // Attribute an item with no identifiable author (UI-only resolution, or a
    // deleted/app account with no email/login) to its PR, so distinct PRs still
    // count as distinct contributors instead of being silently dropped — which
    // would make a genuine recurring wontfix fail the minDistinctAuthors gate.
    const authors = new Set(its.map((it) => it.author || `pr:${it.prId}`));
    const prs = [...new Set(its.map((it) => it.prId))];
    return {
      category: c.category, rule: c.rule, rationale: c.rationale,
      occurrences: its.length, distinctAuthors: authors.size, evidencePrs: prs,
    };
  });

  const promoted = applyThreshold(enriched, {
    minWontfix: cfgLearn.minWontfix, minDistinctAuthors: cfgLearn.minDistinctAuthors,
  });
  const promotedSet = new Set(promoted);
  logInfo('learn.pipeline', {
    stage: 'threshold', candidates: enriched.length, promoted: promoted.length,
    minWontfix: cfgLearn.minWontfix, minDistinctAuthors: cfgLearn.minDistinctAuthors,
    dropped: enriched.filter((c) => !promotedSet.has(c)).map((c) => ({ rule: c.rule, occurrences: c.occurrences, distinctAuthors: c.distinctAuthors })),
  });
  if (promoted.length === 0) { logInfo('learn.pipeline', { stage: 'threshold', result: 'no-proposal' }); return { rules: null, newContent: null, usage }; }

  const { learned } = extractLearnedBlock(standardsText);
  const learnedFingerprints = parseRuleFingerprints(learned);
  const ignoreFingerprints = parseIgnoreFingerprints(ignoreText);
  const novel = filterNovel(promoted, { learnedFingerprints, ignoreFingerprints });
  logInfo('learn.pipeline', {
    stage: 'dedup', promoted: promoted.length, novel: novel.length,
    alreadyLearned: learnedFingerprints.size, ignored: ignoreFingerprints.size,
  });
  if (novel.length === 0) { logInfo('learn.pipeline', { stage: 'dedup', result: 'no-proposal' }); return { rules: null, newContent: null, usage }; }

  // Preserve previously-learned rules; append novel ones.
  const existingRules = parseLearnedRules(learned);
  const merged = [...existingRules, ...novel.map((r) => ({
    category: r.category, rule: r.rule, evidencePrs: r.evidencePrs,
  }))];
  const newContent = spliceLearnedBlock(standardsText, merged);

  logInfo('learn.pipeline', {
    stage: 'render', result: 'proposal', newRules: novel.length,
    existingRules: existingRules.length, totalRules: merged.length,
  });
  return { rules: novel, newContent, usage };
}

module.exports = { buildProposal };
