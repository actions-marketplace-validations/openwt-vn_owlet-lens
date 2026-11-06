// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_SEVERITIES,
  SEVERITY_ORDER,
  validateFindings,
  sortBySeverity,
  buildChangedFilesMap,
  isTestFile,
  __test__: { snapToNearestLine },
} = require('../lib/finding-validator.js');

describe('isTestFile', () => {
  it('matches conventional test paths across ecosystems', () => {
    const yes = [
      'src/foo.test.js', 'src/foo.test.ts', 'src/foo.test.tsx', 'src/foo.spec.jsx',
      'a/foo.test.mjs', 'a/foo.spec.cts',
      '__tests__/foo.js', 'pkg/__tests__/sub/foo.ts',
      'test/foo.js', 'tests/foo.py', 'app/test/helper.rb',
      'pkg/handler_test.go', 'mod/thing_test.py', 'app/test_views.py',
      'spec/user_spec.rb', 'src/MyServiceTest.java', 'src/MyServiceTest.kt',
    ];
    for (const p of yes) assert.equal(isTestFile(p), true, p);
  });

  it('does not match production files', () => {
    const no = [
      'src/foo.js', 'src/service.ts', 'lib/handler.go', 'app/views.py',
      'src/contest.js', 'src/latest.ts', 'src/attestation.go',
      'testimony.md', 'protest/index.js',
    ];
    for (const p of no) assert.equal(isTestFile(p), false, p);
  });

  it('returns false for non-string input', () => {
    assert.equal(isTestFile(/** @type {any} */ (null)), false);
    assert.equal(isTestFile(/** @type {any} */ (undefined)), false);
    assert.equal(isTestFile(/** @type {any} */ (42)), false);
  });
});

describe('VALID_SEVERITIES', () => {
  it('contains exactly CRITICAL, HIGH, MEDIUM, LOW', () => {
    assert.deepEqual([...VALID_SEVERITIES].sort(), ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  });
});

describe('SEVERITY_ORDER', () => {
  it('CRITICAL has lowest order value (highest priority)', () => {
    assert.ok(SEVERITY_ORDER.get('CRITICAL') < SEVERITY_ORDER.get('HIGH'));
    assert.ok(SEVERITY_ORDER.get('HIGH') < SEVERITY_ORDER.get('MEDIUM'));
    assert.ok(SEVERITY_ORDER.get('MEDIUM') < SEVERITY_ORDER.get('LOW'));
  });
});

describe('validateFindings', () => {
  const changedFiles = new Map([
    ['backend/src/users.ts', new Set([10, 11, 12, 20, 21])],
  ]);

  it('should accept valid findings', () => {
    const findings = [
      { file: 'backend/src/users.ts', line: 10, severity: 'HIGH', category: 'bug', message: 'Missing null check' },
    ];
    const result = validateFindings(findings, changedFiles);
    assert.equal(result.length, 1);
  });

  it('should discard findings for unknown files', () => {
    const findings = [
      { file: 'unknown/file.ts', line: 1, severity: 'HIGH', category: 'bug', message: 'Issue' },
    ];
    const result = validateFindings(findings, changedFiles);
    assert.equal(result.length, 0);
  });

  it('should discard findings with out-of-range lines', () => {
    const findings = [
      { file: 'backend/src/users.ts', line: 999, severity: 'HIGH', category: 'bug', message: 'Issue' },
    ];
    const result = validateFindings(findings, changedFiles);
    assert.equal(result.length, 0);
  });

  it('should discard findings with missing required fields', () => {
    const findings = [
      { file: 'backend/src/users.ts', severity: 'HIGH' },
      { line: 10, severity: 'HIGH', message: 'test' },
    ];
    const result = validateFindings(findings, changedFiles);
    assert.equal(result.length, 0);
  });

  it('should discard findings with invalid severity', () => {
    const findings = [
      { file: 'backend/src/users.ts', line: 10, severity: 'EXTREME', category: 'bug', message: 'Issue' },
    ];
    const result = validateFindings(findings, changedFiles);
    assert.equal(result.length, 0);
  });

  it('should handle non-array input', () => {
    assert.deepEqual(validateFindings(null, changedFiles), []);
    assert.deepEqual(validateFindings('string', changedFiles), []);
    assert.deepEqual(validateFindings(42, changedFiles), []);
  });

  it('writes discard reasons as stderr JSON, never stdout', () => {
    const findings = [
      { file: 'unknown.ts', line: 1, severity: 'HIGH', category: 'bug', message: 'unknown file' },
      { file: 'backend/src/users.ts', line: 999, severity: 'HIGH', category: 'bug', message: 'oob line' },
    ];

    const stdoutChunks = [];
    const stderrChunks = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s) => { stdoutChunks.push(String(s)); return true; };
    process.stderr.write = (s) => { stderrChunks.push(String(s)); return true; };
    try {
      validateFindings(findings, changedFiles);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    assert.equal(stdoutChunks.join(''), '', 'stdout must remain empty');
    const stderrCombined = stderrChunks.join('');
    assert.ok(stderrCombined.includes('finding.discarded'), 'stderr must contain discard log');
    for (const line of stderrCombined.trim().split('\n')) {
      if (!line) continue;
      const parsed = JSON.parse(line);
      assert.equal(parsed.level, 'warn');
      assert.equal(parsed.msg, 'finding.discarded');
      assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
    }
  });
});

describe('sortBySeverity', () => {
  it('sorts findings from highest to lowest severity', () => {
    const findings = [
      { file: 'a.ts', line: 1, severity: 'LOW', category: 'style', message: 'Style issue' },
      { file: 'a.ts', line: 2, severity: 'CRITICAL', category: 'security', message: 'SQL injection' },
      { file: 'a.ts', line: 3, severity: 'MEDIUM', category: 'bug', message: 'Missing check' },
      { file: 'a.ts', line: 4, severity: 'HIGH', category: 'bug', message: 'Null deref' },
    ];
    const sorted = sortBySeverity(findings);

    assert.equal(sorted[0].severity, 'CRITICAL');
    assert.equal(sorted[1].severity, 'HIGH');
    assert.equal(sorted[2].severity, 'MEDIUM');
    assert.equal(sorted[3].severity, 'LOW');
  });

  it('preserves order for same severity (stable sort)', () => {
    const findings = [
      { file: 'a.ts', line: 1, severity: 'HIGH', category: 'bug', message: 'First HIGH' },
      { file: 'b.ts', line: 2, severity: 'HIGH', category: 'bug', message: 'Second HIGH' },
      { file: 'c.ts', line: 3, severity: 'HIGH', category: 'bug', message: 'Third HIGH' },
    ];
    const sorted = sortBySeverity(findings);

    assert.equal(sorted[0].message, 'First HIGH');
    assert.equal(sorted[1].message, 'Second HIGH');
    assert.equal(sorted[2].message, 'Third HIGH');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(sortBySeverity([]), []);
  });

  it('does not mutate the original array', () => {
    const findings = [
      { file: 'a.ts', line: 1, severity: 'LOW', category: 'style', message: 'Low' },
      { file: 'a.ts', line: 2, severity: 'HIGH', category: 'bug', message: 'High' },
    ];
    const original = [...findings];
    sortBySeverity(findings);

    assert.equal(findings[0].severity, original[0].severity);
    assert.equal(findings[1].severity, original[1].severity);
  });
});

describe('buildChangedFilesMap', () => {
  it('builds a map of file paths to changed line sets', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:+added line\n11: context\n12:-removed line' },
      { filePath: 'src/b.ts', annotatedDiff: '5:+new code' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);

    assert.ok(map.has('src/a.ts'));
    assert.ok(map.get('src/a.ts').has(10));
    assert.ok(map.get('src/a.ts').has(12));
    assert.ok(!map.get('src/a.ts').has(11), 'Context lines should not be in the set');
    assert.ok(map.has('src/b.ts'));
    assert.ok(map.get('src/b.ts').has(5));
  });

  it('returns empty map for empty input', () => {
    const map = buildChangedFilesMap([]);
    assert.equal(map.size, 0);
  });

  it('skips files with empty annotated diff', () => {
    const annotatedDiffs = [
      { filePath: 'src/empty.ts', annotatedDiff: '' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);
    assert.equal(map.size, 0);
  });
});

describe('buildChangedFilesMap deletion tracking', () => {
  it('returns both addedLines and deletedLines per file', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:+added\n11:-deleted\n12: context' },
    ];
    const result = buildChangedFilesMap(annotatedDiffs);

    assert.ok(result.get('src/a.ts').has(10));
    assert.ok(result.get('src/a.ts').has(11));

    assert.ok(result.detail);
    const detail = result.detail.get('src/a.ts');
    assert.ok(detail.added.has(10));
    assert.ok(!detail.added.has(11));
    assert.ok(detail.deleted.has(11));
    assert.ok(!detail.deleted.has(10));
  });
});

describe('validateFindings deletion tagging', () => {
  it('passes deletion-only line and tags finding with deletion: true', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:-removed\n10: context' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);
    const findings = [
      { file: 'src/a.ts', line: 10, severity: 'HIGH', category: 'bug', message: 'removed important guard' },
    ];
    const valid = validateFindings(findings, map);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].deletion, true,
      'deletion-only citation must be tagged so post path can warn-and-drop');
  });

  it('snaps out-of-range line to nearest valid line within ±5 window', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:+added\n14:+added\n20:+added' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);
    const findings = [
      { file: 'src/a.ts', line: 12, severity: 'HIGH', category: 'bug', message: 'near line 10 and 14' },
    ];
    const valid = validateFindings(findings, map);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].line, 10, 'should snap to nearest (10 is 2 away, 14 is 2 away, lower wins)');
  });

  it('drops finding when no valid line exists within ±5 window', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:+added\n30:+added' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);
    const findings = [
      { file: 'src/a.ts', line: 20, severity: 'HIGH', category: 'bug', message: 'too far from any changed line' },
    ];
    const valid = validateFindings(findings, map);
    assert.equal(valid.length, 0);
  });

  it('does not tag deletion when the line is also added', () => {
    const annotatedDiffs = [
      { filePath: 'src/a.ts', annotatedDiff: '10:+new\n10:-old' },
    ];
    const map = buildChangedFilesMap(annotatedDiffs);
    const findings = [
      { file: 'src/a.ts', line: 10, severity: 'HIGH', category: 'bug', message: 'something' },
    ];
    const valid = validateFindings(findings, map);
    assert.equal(valid.length, 1);
    assert.ok(!valid[0].deletion);
  });
});

describe('snapToNearestLine', () => {
  it('returns the line itself when it is in the set', () => {
    const validLines = new Set([10, 20, 30]);
    assert.equal(snapToNearestLine(20, validLines, 5), 20);
  });

  it('snaps to nearest valid line within window', () => {
    const validLines = new Set([10, 20, 30]);
    assert.equal(snapToNearestLine(18, validLines, 5), 20);
  });

  it('returns null when no valid line within window', () => {
    const validLines = new Set([10, 30]);
    assert.equal(snapToNearestLine(20, validLines, 5), null);
  });

  it('breaks ties by choosing lower line number', () => {
    const validLines = new Set([8, 12]);
    assert.equal(snapToNearestLine(10, validLines, 5), 8);
  });

  it('rejects non-positive line numbers', () => {
    const validLines = new Set([1, 2, 3]);
    assert.equal(snapToNearestLine(0, validLines, 5), null);
    assert.equal(snapToNearestLine(-1, validLines, 5), null);
  });

  it('snaps at exact window boundary (±5)', () => {
    const validLines = new Set([15]);
    assert.equal(snapToNearestLine(10, validLines, 5), 15, 'exactly +5 should snap');
    assert.equal(snapToNearestLine(20, validLines, 5), 15, 'exactly -5 should snap');
    assert.equal(snapToNearestLine(9, validLines, 5), null, '+6 should not snap');
    assert.equal(snapToNearestLine(21, validLines, 5), null, '-6 should not snap');
  });
});
