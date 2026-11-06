'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractSuppressionRules,
  renderSuppressionSection,
  SECTION_HEADER,
} = require('../lib/learn/suppression-context.js');
const { renderLearnedBlock } = require('../lib/learn/standards-block.js');

function standardsWith(rules) {
  return `# Standards\n\nHuman rule above.\n\n${renderLearnedBlock(rules)}\n`;
}

test('extractSuppressionRules pulls rules out of the learned block', () => {
  const text = standardsWith([
    { category: 'bug', rule: 'unsignedInteger is correct for increments(id) tables', evidencePrs: ['2476'] },
  ]);
  const rules = extractSuppressionRules(text);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].category, 'bug');
  assert.match(rules[0].rule, /unsignedInteger/);
  assert.deepEqual(rules[0].evidencePrs, ['2476']);
});

test('extractSuppressionRules returns [] when no learned block', () => {
  assert.deepEqual(extractSuppressionRules('# Standards\n\njust human rules'), []);
});

test('extractSuppressionRules returns [] for empty / non-string input', () => {
  assert.deepEqual(extractSuppressionRules(''), []);
  assert.deepEqual(extractSuppressionRules(null), []);
  assert.deepEqual(extractSuppressionRules(undefined), []);
});

test('renderSuppressionSection returns empty string for no rules', () => {
  assert.equal(renderSuppressionSection([]), '');
  assert.equal(renderSuppressionSection(null), '');
});

test('renderSuppressionSection includes header, category, rule, and PR evidence', () => {
  const out = renderSuppressionSection([
    { category: 'bug', rule: 'unsignedInteger matches increments(id)', evidencePrs: ['2476', '2480'] },
  ]);
  assert.ok(out.includes(SECTION_HEADER));
  assert.ok(out.includes('[bug]'));
  assert.ok(out.includes('unsignedInteger matches increments(id)'));
  assert.ok(out.includes('#2476, #2480'));
});

test('renderSuppressionSection omits evidence clause when no PRs', () => {
  const out = renderSuppressionSection([
    { category: 'style', rule: 'snake_case allowed in migrations', evidencePrs: [] },
  ]);
  assert.ok(out.includes('snake_case allowed in migrations'));
  assert.ok(!out.includes('wontfix on'));
});

test('round-trip: extract then render reproduces rule text', () => {
  const rules = [
    { category: 'bug', rule: 'FK unsignedInteger ok for increments id', evidencePrs: ['2476'] },
  ];
  const section = renderSuppressionSection(extractSuppressionRules(standardsWith(rules)));
  assert.ok(section.includes('FK unsignedInteger ok for increments id'));
});
