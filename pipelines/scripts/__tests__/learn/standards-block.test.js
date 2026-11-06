// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ruleFingerprint, extractLearnedBlock, parseRuleFingerprints,
  renderLearnedBlock, spliceLearnedBlock, parseLearnedRules, START, END,
} = require('../../lib/learn/standards-block.js');

describe('ruleFingerprint', () => {
  it('is stable across whitespace/case/punct', () => {
    const a = ruleFingerprint('architecture', 'Prefer X over Y.');
    const b = ruleFingerprint('architecture', '  prefer   x over y  ');
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{16}$/);
  });
  it('differs by category', () => {
    assert.notEqual(ruleFingerprint('style', 'same rule'), ruleFingerprint('naming', 'same rule'));
  });
});

describe('extractLearnedBlock', () => {
  it('returns null learned when no block present', () => {
    const r = extractLearnedBlock('# Standards\nhuman rules\n');
    assert.equal(r.learned, null);
    assert.equal(r.before, '# Standards\nhuman rules\n');
  });
  it('splits before/learned/after around markers', () => {
    const text = `top\n${START}\ninner\n${END}\nbottom`;
    const r = extractLearnedBlock(text);
    assert.equal(r.learned, '\ninner\n');
    assert.equal(r.before, 'top\n');
    assert.equal(r.after, '\nbottom');
  });
});

describe('parseRuleFingerprints', () => {
  it('collects all learned-rule hashes', () => {
    const inner = 'x <!-- ai-review:learned-rule=abc123abc123abcd --> y <!-- ai-review:learned-rule=0011223344556677 -->';
    const set = parseRuleFingerprints(inner);
    assert.deepEqual([...set].sort(), ['0011223344556677', 'abc123abc123abcd']);
  });
  it('returns empty set for null', () => {
    assert.equal(parseRuleFingerprints(null).size, 0);
  });
});

describe('renderLearnedBlock', () => {
  it('wraps rules in markers with fingerprint + evidence', () => {
    const block = renderLearnedBlock([
      { category: 'architecture', rule: 'Prefer X over Y', evidencePrs: ['12', '18'] },
    ]);
    assert.ok(block.startsWith(START));
    assert.ok(block.trimEnd().endsWith(END));
    assert.match(block, /\*\*\[architecture\]\*\* Prefer X over Y/);
    assert.match(block, /PRs #12, #18/);
    assert.match(block, /<!-- ai-review:learned-rule=[a-f0-9]{16} -->/);
  });
});

describe('spliceLearnedBlock', () => {
  it('appends a block when none exists', () => {
    const out = spliceLearnedBlock('# Std\nrules\n', [{ category: 'style', rule: 'r', evidencePrs: ['1'] }]);
    assert.ok(out.startsWith('# Std\nrules\n'));
    assert.ok(out.includes(START) && out.includes(END));
  });
  it('replaces an existing block, preserving human text', () => {
    const orig = `HUMAN\n\n${START}\nold\n${END}\n`;
    const out = spliceLearnedBlock(orig, [{ category: 'style', rule: 'new rule', evidencePrs: ['9'] }]);
    assert.ok(out.startsWith('HUMAN\n'));
    assert.ok(out.includes('new rule'));
    assert.ok(!out.includes('\nold\n'));
    assert.equal((out.match(/learned:start/g) || []).length, 1);
  });
});

describe('parseLearnedRules round-trips renderLearnedBlock', () => {
  it('recovers rules', () => {
    const block = renderLearnedBlock([{ category: 'style', rule: 'Allow trailing commas', evidencePrs: ['12', '18'] }]);
    const { learned } = extractLearnedBlock(`x\n${block}\ny`);
    const rules = parseLearnedRules(learned);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule, 'Allow trailing commas');
    assert.deepEqual(rules[0].evidencePrs, ['12', '18']);
  });

  it('recovers a rule whose text contains newlines (single-lined at render)', () => {
    const block = renderLearnedBlock([
      { category: 'style', rule: 'Prefer early returns\nover deep nesting', evidencePrs: ['7'] },
    ]);
    const { learned } = extractLearnedBlock(`x\n${block}\ny`);
    const rules = parseLearnedRules(learned);
    // Without single-lining, BULLET_RE fails and this rule would be erased.
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule, 'Prefer early returns over deep nesting');
  });
});
