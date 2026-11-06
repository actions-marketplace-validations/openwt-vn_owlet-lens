// @ts-check
'use strict';

const { hashMessage } = require('../fingerprint.js');

const START = '<!-- ai-review:learned:start v1 -->';
const END = '<!-- ai-review:learned:end -->';
const RULE_MARKER_RE = /<!--\s*ai-review:learned-rule=([a-f0-9]{16})\s*-->/g;
const BULLET_RE = /- \*\*\[([a-z]+)\]\*\* (.+?)\n(?:\s+_Learned from wontfix across PRs ([^_]+)\._\n)?\s*<!-- ai-review:learned-rule=([a-f0-9]{16}) -->/g;

/**
 * Normalise a rule string for stable fingerprinting.
 * @param {string} rule
 * @returns {string}
 */
function normalize(rule) {
  return String(rule ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;:,\s]+$/, '');
}

/**
 * Stable 16-hex fingerprint for a category+rule pair.
 * @param {string} category
 * @param {string} rule
 * @returns {string}
 */
function ruleFingerprint(category, rule) {
  return hashMessage(`${String(category).toLowerCase()}:${normalize(rule)}`, 16);
}

/**
 * Split a standards file into the text before/inside/after the learned block.
 * @param {string} fileText
 * @returns {{ before: string, learned: string|null, after: string }}
 */
function extractLearnedBlock(fileText) {
  const text = typeof fileText === 'string' ? fileText : '';
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s) return { before: text, learned: null, after: '' };
  return {
    before: text.slice(0, s),
    learned: text.slice(s + START.length, e),
    after: text.slice(e + END.length),
  };
}

/**
 * Collect all learned-rule fingerprint hashes from the learned block text.
 * @param {string|null} learnedText
 * @returns {Set<string>}
 */
function parseRuleFingerprints(learnedText) {
  const set = new Set();
  if (typeof learnedText !== 'string') return set;
  let m;
  RULE_MARKER_RE.lastIndex = 0;
  while ((m = RULE_MARKER_RE.exec(learnedText)) !== null) set.add(m[1]);
  return set;
}

/**
 * Render a full learned block (START…END) from an array of rule objects.
 * @param {Array<{category: string, rule: string, evidencePrs: string[]}>} rules
 * @returns {string}
 */
function renderLearnedBlock(rules) {
  const lines = [
    START,
    '<!-- Auto-managed by `ai-review learn`. Edit ABOVE this block, not inside. -->',
    '',
    '### Learned conventions',
    '',
  ];
  for (const r of rules) {
    const fp = ruleFingerprint(r.category, r.rule);
    const prs = (r.evidencePrs || []).map((p) => `#${p}`).join(', ');
    // Collapse the rule to a single line: BULLET_RE matches `(.+?)\n`, so a rule
    // containing a newline would render across two lines and fail to parse on
    // the next run — silently erasing the rule from the standards file. (The
    // fingerprint is whitespace-normalized identically, so dedup is unaffected.)
    const ruleOneLine = String(r.rule).replace(/\s+/g, ' ').trim();
    lines.push(`- **[${r.category}]** ${ruleOneLine}`);
    if (prs) lines.push(`  _Learned from wontfix across PRs ${prs}._`);
    lines.push(`  <!-- ai-review:learned-rule=${fp} -->`);
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * Splice a new learned block into a standards file, replacing any existing one
 * or appending if none is present.
 * @param {string} fileText
 * @param {Array<{category: string, rule: string, evidencePrs: string[]}>} rules
 * @returns {string}
 */
function spliceLearnedBlock(fileText, rules) {
  const block = renderLearnedBlock(rules);
  const { before, learned, after } = extractLearnedBlock(fileText);
  if (learned === null) {
    const base = before.endsWith('\n') ? before : `${before}\n`;
    return `${base}\n${block}\n`;
  }
  return `${before}${block}${after}`;
}

/**
 * Parse rule objects back out of a learned block's inner text.
 * @param {string|null} learnedText
 * @returns {Array<{category: string, rule: string, evidencePrs: string[]}>}
 */
function parseLearnedRules(learnedText) {
  const out = [];
  if (typeof learnedText !== 'string') return out;
  let m;
  BULLET_RE.lastIndex = 0;
  while ((m = BULLET_RE.exec(learnedText)) !== null) {
    const prs = m[3] ? m[3].split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean) : [];
    out.push({ category: m[1], rule: m[2].trim(), evidencePrs: prs });
  }
  return out;
}

module.exports = {
  START,
  END,
  ruleFingerprint,
  extractLearnedBlock,
  parseRuleFingerprints,
  renderLearnedBlock,
  spliceLearnedBlock,
  parseLearnedRules,
};
