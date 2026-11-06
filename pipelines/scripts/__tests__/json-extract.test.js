// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractJson } = require('../lib/json-extract.js');

const isFindings = (obj) => Boolean(obj) && typeof obj === 'object' && Array.isArray(obj.findings);

test('extractJson: parses a bare object', () => {
  assert.deepEqual(
    extractJson('{"verdict":"fixed","reasoning":"ok"}'),
    { verdict: 'fixed', reasoning: 'ok' },
  );
});

test('extractJson: strips surrounding prose', () => {
  const r = extractJson('Some prose\n{"verdict":"wontfix","reasoning":"nope"}\ntrailing');
  assert.equal(r.verdict, 'wontfix');
});

test('extractJson: parses a fenced ```json block surrounded by prose', () => {
  const text = "Here's my review:\n\n```json\n{\"findings\":[]}\n```\n\nLet me know.";
  assert.deepEqual(extractJson(text), { findings: [] });
});

test('extractJson: preserves a triple-backtick fence inside a string value', () => {
  const r = extractJson('```json\n{"verdict":"wontfix","reasoning":"uses ```ts code``` syntax"}\n```');
  assert.equal(r.verdict, 'wontfix');
  assert.equal(r.reasoning, 'uses ```ts code``` syntax');
});

test('extractJson: is string-aware, braces inside string literals', () => {
  const text = '{"findings":[{"file":"a","line":1,"severity":"LOW","category":"x","message":"bad } brace"}]}';
  const out = extractJson(text);
  assert.ok(out);
  assert.equal(out.findings[0].message, 'bad } brace');
});

test('extractJson: handles escaped quotes inside string literals', () => {
  const text = '{"findings":[{"file":"a","line":1,"severity":"LOW","category":"x","message":"escaped \\" quote with } inside"}]}';
  const out = extractJson(text);
  assert.ok(out);
  assert.match(out.findings[0].message, /escaped " quote/);
});

test('extractJson: returns null when there is no JSON', () => {
  assert.equal(extractJson('just words'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(/** @type {any} */ (null)), null);
  assert.equal(extractJson(/** @type {any} */ (42)), null);
});

test('extractJson: returns null on malformed JSON inside braces', () => {
  assert.equal(extractJson('{not valid json}'), null);
});

test('extractJson: rejects greedy first-{ to last-} text that is not valid JSON', () => {
  const text = 'Here is JSON: {bad: not valid} and then {valid trailing prose}';
  assert.equal(extractJson(text), null);
});

test('extractJson: skips malformed candidates and recovers a later valid object', () => {
  const text = '{bad} then {"verdict":"active"}';
  assert.deepEqual(extractJson(text), { verdict: 'active' });
});

test('extractJson: accept predicate returns the first matching object', () => {
  const text = '{"summary":"only summary"} {"findings":[{"file":"a"}]}';
  assert.deepEqual(extractJson(text), { summary: 'only summary' });
  assert.deepEqual(extractJson(text, isFindings), { findings: [{ file: 'a' }] });
});

test('extractJson: accept predicate skips an earlier malformed / non-matching object', () => {
  assert.deepEqual(extractJson('{bad} {"findings":[]}', isFindings), { findings: [] });
  assert.deepEqual(extractJson('{"summary":"x"} {"findings":[]}', isFindings), { findings: [] });
});

test('extractJson: accept predicate returns null when nothing matches', () => {
  assert.equal(extractJson('{"summary":"only summary"}', isFindings), null);
});
