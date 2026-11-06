// @ts-check
'use strict';

const { extractLearnedBlock, parseLearnedRules } = require('./standards-block.js');

const SECTION_HEADER = '=== DO NOT RE-FLAG (team already rejected these) ===';

/**
 * Pull the learned-conventions rules out of a coding-standards file's text.
 * These are patterns the team marked `wontfix`, mined by the learn pipeline.
 *
 * @param {string|null|undefined} codingStandardsText - full text of codingStandardsPath
 * @returns {Array<{category: string, rule: string, evidencePrs: string[]}>}
 */
function extractSuppressionRules(codingStandardsText) {
  if (typeof codingStandardsText !== 'string' || codingStandardsText === '') return [];
  const { learned } = extractLearnedBlock(codingStandardsText);
  if (learned === null) return [];
  return parseLearnedRules(learned);
}

/**
 * Render a high-salience suppression section for the system prompt. Returns ''
 * when there are no rules so callers can append unconditionally. Placed last in
 * the system prompt by the caller so recency reinforces adherence — the learn
 * pipeline's rules were previously buried inside the standards blob and ignored.
 *
 * @param {Array<{category: string, rule: string, evidencePrs: string[]}>} rules
 * @returns {string}
 */
function renderSuppressionSection(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const lines = [
    SECTION_HEADER,
    'The team reviewed and explicitly rejected (marked wontfix) the patterns below.',
    'Do NOT raise any finding that matches one of these. If a candidate finding',
    'matches a rule here, suppress it entirely — the team already decided.',
    '',
  ];
  for (const r of rules) {
    const prs = (r.evidencePrs || []).map((p) => `#${p}`).join(', ');
    const evidence = prs ? ` (wontfix on ${prs})` : '';
    lines.push(`- [${r.category}] ${r.rule}${evidence}`);
  }
  return lines.join('\n');
}

module.exports = { extractSuppressionRules, renderSuppressionSection, SECTION_HEADER };
