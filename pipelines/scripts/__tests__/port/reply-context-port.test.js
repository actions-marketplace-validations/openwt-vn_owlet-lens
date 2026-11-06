'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('../../lib/port/reply-context-port.js');
const { sliceFileDiff, sliceSnippet, buildThreadTranscript } = __test__;

test('sliceFileDiff: returns patch for matching path', () => {
  const diffFiles = [
    { path: 'src/a.js', change: 'modify', patch: '@@ -1 +1 @@\n-a\n+b' },
    { path: 'src/b.js', change: 'modify', patch: '@@ -1 +1 @@\n-c\n+d' },
  ];
  assert.equal(sliceFileDiff(diffFiles, 'src/a.js'), '@@ -1 +1 @@\n-a\n+b');
});

test('sliceFileDiff: returns "" when file not in diff', () => {
  const diffFiles = [{ path: 'src/a.js', change: 'modify', patch: 'x' }];
  assert.equal(sliceFileDiff(diffFiles, 'src/missing.js'), '');
});

test('sliceFileDiff: matches via oldPath for renames', () => {
  const diffFiles = [
    { path: 'src/new.js', oldPath: 'src/old.js', change: 'rename', patch: '@@ rename @@' },
  ];
  assert.equal(sliceFileDiff(diffFiles, 'src/old.js'), '@@ rename @@');
  assert.equal(sliceFileDiff(diffFiles, 'src/new.js'), '@@ rename @@');
});

test('sliceFileDiff: returns "" for empty diff', () => {
  assert.equal(sliceFileDiff([], 'src/a.js'), '');
});

test('sliceSnippet: ±5 lines around middle line, 1-indexed, padded numbers', () => {
  const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
  const out = sliceSnippet(content, 10);
  const lines = out.split('\n');
  assert.equal(lines.length, 11);
  assert.ok(lines[0].includes('line5'));
  assert.ok(lines[10].includes('line15'));
  assert.match(lines[0], /^ {0,3}5 \| line5$/);
});

test('sliceSnippet: clips at file start (line 1)', () => {
  const content = 'a\nb\nc\nd\ne\nf';
  const out = sliceSnippet(content, 1);
  const lines = out.split('\n');
  assert.ok(lines[0].includes(' 1 | a'));
  assert.ok(lines.length <= 6);
});

test('sliceSnippet: clips at EOF', () => {
  const content = 'a\nb\nc';
  const out = sliceSnippet(content, 3);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[lines.length - 1].includes(' 3 | c'));
});

test('sliceSnippet: returns "" on null content', () => {
  assert.equal(sliceSnippet(null, 10), '');
});

test('buildThreadTranscript: chronological with AI/dev labels and original-finding marker', () => {
  const comments = [
    { isBot: true, body: 'finding text' },
    { isBot: false, body: 'dev question', author: 'alice' },
    { isBot: true, body: 'bot clarification' },
    { isBot: false, body: 'done', author: 'alice' },
  ];
  const out = buildThreadTranscript(comments);
  assert.ok(out.includes('--- AI [original finding] ---\nfinding text'));
  assert.ok(out.includes('--- dev (alice) ---\ndev question'));
  assert.ok(out.includes('--- AI ---\nbot clarification'));
  assert.ok(out.includes('--- dev (alice) ---\ndone'));
  const findIdx = out.indexOf('finding text');
  const qIdx = out.indexOf('dev question');
  const clarIdx = out.indexOf('bot clarification');
  const doneIdx = out.indexOf('\ndone');
  assert.ok(findIdx < qIdx && qIdx < clarIdx && clarIdx < doneIdx);
});

test('buildThreadTranscript: handles missing author gracefully', () => {
  const comments = [
    { isBot: true, body: 'finding' },
    { isBot: false, body: 'reply' },
  ];
  const out = buildThreadTranscript(comments);
  assert.ok(out.includes('--- dev ---\nreply'));
});

test('buildThreadTranscript: uses authorEmail when author is missing (real ThreadComment shape)', () => {
  const comments = [
    { isBot: true, body: 'finding', authorEmail: 'bot@x' },
    { isBot: false, body: 'fixed it', authorEmail: 'alice@example.com' },
  ];
  const out = buildThreadTranscript(comments);
  assert.ok(out.includes('--- dev (alice@example.com) ---\nfixed it'));
});

const { assembleReplyContext } = require('../../lib/port/reply-context-port.js');

function makeThread({ filePath = 'src/a.js', line = 10, comments } = {}) {
  return {
    id: 'T1',
    filePath,
    line,
    comments: comments ?? [
      { isBot: true, body: 'finding' },
      { isBot: false, body: 'fixed it', author: 'alice' },
    ],
  };
}

test('assembleReplyContext: returns thread + snippet + diff slice with no warnings on happy path', async () => {
  const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
  const provider = {
    getFileContent: async () => content,
  };
  const prDiff = [{ path: 'src/a.js', change: 'modify', patch: '@@ a @@' }];
  const out = await assembleReplyContext({
    provider, thread: makeThread(), prDiff, headSha: 'abc', fileCache: new Map(),
  });
  assert.ok(out.fullThread.includes('finding'));
  assert.ok(out.codeSnippet.includes('line10'));
  assert.equal(out.diffSlice, '@@ a @@');
  assert.deepEqual(out.warnings, []);
});

test('assembleReplyContext: caches getFileContent per (path, sha)', async () => {
  let calls = 0;
  const provider = {
    getFileContent: async () => { calls += 1; return 'x'; },
  };
  const fileCache = new Map();
  await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache,
  });
  await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache,
  });
  assert.equal(calls, 1);
});

test('assembleReplyContext: does not cache across different sha', async () => {
  let calls = 0;
  const provider = {
    getFileContent: async () => { calls += 1; return 'x'; },
  };
  const fileCache = new Map();
  await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache,
  });
  await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'def', fileCache,
  });
  assert.equal(calls, 2);
});

test('assembleReplyContext: deduplicates concurrent fetches via in-flight Promise cache', async () => {
  let calls = 0;
  const provider = {
    getFileContent: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 'x';
    },
  };
  const fileCache = new Map();
  const [a, b] = await Promise.all([
    assembleReplyContext({ provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache }),
    assembleReplyContext({ provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache }),
  ]);
  assert.equal(calls, 1);
  assert.ok(a.codeSnippet === b.codeSnippet);
});

test('assembleReplyContext: rejected fetch evicts cache entry so later threads retry', async () => {
  let calls = 0;
  const recovered = Array.from({ length: 20 }, (_, i) => `recovered${i + 1}`).join('\n');
  const provider = {
    getFileContent: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return recovered;
    },
  };
  const fileCache = new Map();
  const out1 = await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache,
  });
  const out2 = await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache,
  });
  assert.equal(calls, 2, 'second thread re-fetched after eviction');
  assert.match(out1.warnings[0], /getFileContent failed: transient/);
  assert.ok(out2.codeSnippet.includes('recovered10'), 'second thread saw recovered content');
  assert.deepEqual(out2.warnings, []);
});

test('assembleReplyContext: getFileContent throw → warning + empty snippet, no rethrow', async () => {
  const provider = {
    getFileContent: async () => { throw new Error('boom'); },
  };
  const out = await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache: new Map(),
  });
  assert.equal(out.codeSnippet, '');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /getFileContent failed: boom/);
});

test('assembleReplyContext: null file content → "file not found" warning', async () => {
  const provider = {
    getFileContent: async () => null,
  };
  const out = await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc', fileCache: new Map(),
  });
  assert.equal(out.codeSnippet, '');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /file not found at HEAD: src\/a\.js/);
});

test('assembleReplyContext: works without fileCache', async () => {
  const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
  const provider = { getFileContent: async () => content };
  const out = await assembleReplyContext({
    provider, thread: makeThread(), prDiff: [], headSha: 'abc',
  });
  assert.ok(out.codeSnippet.includes('line10'));
});
