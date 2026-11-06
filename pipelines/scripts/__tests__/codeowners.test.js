'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodeowners, matchPattern, findOwners } = require('../lib/codeowners.js');

test('parseCodeowners parses standard format', () => {
  const content = [
    '# Comment line',
    '*.js @frontend-team',
    '/backend/ @backend-team @lead',
    '',
    'docs/* @docs-team',
  ].join('\n');
  const rules = parseCodeowners(content);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { pattern: '*.js', owners: ['@frontend-team'] });
  assert.deepEqual(rules[1], { pattern: '/backend/', owners: ['@backend-team', '@lead'] });
  assert.deepEqual(rules[2], { pattern: 'docs/*', owners: ['@docs-team'] });
});

test('parseCodeowners ignores blank lines and comments', () => {
  const rules = parseCodeowners('# only comments\n\n');
  assert.equal(rules.length, 0);
});

test('matchPattern matches wildcard extension', () => {
  assert.ok(matchPattern('src/app.js', '*.js'));
  assert.ok(!matchPattern('src/app.ts', '*.js'));
});

test('matchPattern matches directory', () => {
  assert.ok(matchPattern('backend/src/main.js', '/backend/'));
  assert.ok(!matchPattern('frontend/main.js', '/backend/'));
});

test('matchPattern matches star-all', () => {
  assert.ok(matchPattern('anything.txt', '*'));
});

test('matchPattern matches directory glob', () => {
  assert.ok(matchPattern('docs/readme.md', 'docs/*'));
});

test('findOwners returns last-match-wins owners', () => {
  const rules = [
    { pattern: '*.js', owners: ['@frontend'] },
    { pattern: '/backend/', owners: ['@backend'] },
  ];
  const files = ['backend/app.js', 'frontend/ui.js'];
  const owners = findOwners(files, rules);
  assert.ok(owners.has('@backend'));
  assert.ok(owners.get('@backend').includes('backend/app.js'));
  assert.ok(owners.has('@frontend'));
  assert.ok(owners.get('@frontend').includes('frontend/ui.js'));
});

test('parseCodeowners strips inline comments', () => {
  const content = '*.js @frontend-team # UI code\n';
  const rules = parseCodeowners(content);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].owners, ['@frontend-team']);
});

test('matchPattern root-anchored pattern does not match nested', () => {
  assert.ok(matchPattern('backend/src/main.js', '/backend/'));
  assert.ok(!matchPattern('src/backend/main.js', '/backend/'));
});

test('matchPattern handles regex metacharacters in pattern', () => {
  assert.ok(matchPattern('src/file.test.js', '*.test.js'));
  assert.ok(!matchPattern('src/filetestxjs', '*.test.js'));
});

test('findOwners handles files with no matching rule', () => {
  const rules = [{ pattern: '*.py', owners: ['@python'] }];
  const owners = findOwners(['readme.md'], rules);
  assert.equal(owners.size, 0);
});
