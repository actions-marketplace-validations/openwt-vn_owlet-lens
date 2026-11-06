// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('../../lib/port/reply-evaluator.js');

// --- #86: the reply payload runs through the SEC-4 diff redactor ---

test('buildUserPrompt: redacts a secret in the diff slice', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'F', devReply: 'D',
    diffSlice: "+const url = 'postgres://app:s3cretpass@db:5432/prod';",
  });
  assert.ok(!out.includes('s3cretpass'), 'password survived into the reply prompt');
  assert.ok(out.includes('[REDACTED]'));
});

test('buildUserPrompt: redacts a GitHub token in the code snippet', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'F', devReply: 'D',
    codeSnippet: "const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
  });
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('buildUserPrompt: redacts a secret quoted in the dev reply', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'F', devReply: 'the url postgres://app:s3cretpass@db/prod is internal',
  });
  assert.ok(!out.includes('s3cretpass'));
});

test('buildUserPromptRedacted: reports the redaction count', () => {
  const clean = __test__.buildUserPromptRedacted({ findingBody: 'F', devReply: 'D' });
  assert.equal(clean.redacted, 0);

  const dirty = __test__.buildUserPromptRedacted({
    findingBody: 'F', devReply: 'D', diffSlice: "+password = 'hunter2hunter2hunter2';",
  });
  assert.ok(dirty.redacted > 0);
});

test('buildUserPrompt: leaves ordinary code untouched', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'use parameterized query',
    devReply: 'fixed in commit abc',
  });
  assert.match(out, /use parameterized query/);
  assert.match(out, /fixed in commit abc/);
});

test('buildUserPrompt: includes code snippet when provided', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'F', devReply: 'R', codeSnippet: 'const x = 1;',
  });
  assert.match(out, /const x = 1/);
});

test('buildUserPrompt: legacy shape collapses to findingBody + devReply when new fields absent', () => {
  const out = __test__.buildUserPrompt({ findingBody: 'F', devReply: 'D' });
  assert.ok(out.includes('## Original AI finding\nF'));
  assert.ok(out.includes('## Developer reply\nD'));
  assert.ok(!out.includes('## Full thread transcript'));
  assert.ok(!out.includes('## Current code at finding location'));
  assert.ok(!out.includes('## Diff slice'));
});

test('buildUserPrompt: includes thread + snippet + diff when present', () => {
  const out = __test__.buildUserPrompt({
    findingBody: 'F', devReply: 'D',
    fullThread: 'T', codeSnippet: 'S', diffSlice: 'X',
  });
  assert.ok(out.includes('## Original AI finding\nF'));
  assert.ok(out.includes('## Full thread transcript\nT'));
  assert.ok(out.includes('## Current code at finding location'));
  assert.ok(out.includes('## Diff slice'));
  assert.ok(!out.includes('## Developer reply'));
});

test('evaluate: requests JSON mode with a generous token budget', async () => {
  const capture = {};
  const llmProvider = {
    call: async (sys, usr, opts) => {
      capture.sys = sys;
      capture.usr = usr;
      capture.opts = opts;
      return { text: '{"verdict":"active","reasoning":"unclear"}' };
    },
  };
  await __test__.evaluate({
    findingBody: 'F', devReply: 'D', llmProvider, model: 'm',
  });
  assert.equal(capture.opts.maxTokens, 5000);
  assert.equal(capture.opts.responseFormat, 'json');
});

test('evaluate: forwards fullThread/codeSnippet/diffSlice into the user prompt', async () => {
  const capture = {};
  const llmProvider = {
    call: async (sys, usr, opts) => {
      capture.sys = sys;
      capture.usr = usr;
      capture.opts = opts;
      return { text: '{"verdict":"active","reasoning":"r"}' };
    },
  };
  await __test__.evaluate({
    findingBody: 'F', devReply: 'D',
    fullThread: 'TT', codeSnippet: 'CC', diffSlice: 'DD',
    llmProvider, model: 'm',
  });
  assert.ok(capture.usr.includes('TT'));
  assert.ok(capture.usr.includes('CC'));
  assert.ok(capture.usr.includes('DD'));
});

test('buildSystemPrompt: returns base prompt when no extras', () => {
  const out = __test__.buildSystemPrompt();
  assert.ok(out.startsWith("You evaluate a developer's reply"));
  assert.ok(!out.includes('=== BEGIN PROJECT CONTEXT'));
  assert.ok(!out.includes('=== BEGIN PROJECT CODING STANDARDS'));
});

test('buildSystemPrompt: prepends projectContext and codingStandards with reference-only delimiters', () => {
  const out = __test__.buildSystemPrompt({
    projectContext: 'use NestJS patterns',
    codingStandards: 'no console.log; immutable updates',
  });
  const ctxIdx = out.indexOf('BEGIN PROJECT CONTEXT (reference only');
  const ctxEndIdx = out.indexOf('END PROJECT CONTEXT ===');
  const csIdx = out.indexOf('BEGIN PROJECT CODING STANDARDS (reference only');
  const csEndIdx = out.indexOf('END PROJECT CODING STANDARDS ===');
  const baseIdx = out.indexOf("You evaluate a developer's reply");
  assert.ok(ctxIdx >= 0 && ctxEndIdx > ctxIdx);
  assert.ok(csIdx > ctxEndIdx && csEndIdx > csIdx);
  assert.ok(baseIdx > csEndIdx, 'order: context, then standards, then base');
  assert.ok(out.includes('use NestJS patterns'));
  assert.ok(out.includes('no console.log'));
});

test('buildSystemPrompt: codingStandards-only skips context section', () => {
  const out = __test__.buildSystemPrompt({ codingStandards: 'X' });
  assert.ok(out.includes('=== BEGIN PROJECT CODING STANDARDS (reference only'));
  assert.ok(out.includes('\nX\n'));
  assert.ok(!out.includes('=== BEGIN PROJECT CONTEXT'));
});

test('evaluate: forwards codingStandards/projectContext into system prompt', async () => {
  const capture = {};
  const llmProvider = {
    call: async (sys, usr, opts) => {
      capture.sys = sys;
      capture.usr = usr;
      capture.opts = opts;
      return { text: '{"verdict":"active","reasoning":"r"}' };
    },
  };
  await __test__.evaluate({
    findingBody: 'F', devReply: 'D',
    codingStandards: 'COOL_STANDARD_TOKEN', projectContext: 'COOL_CONTEXT_TOKEN',
    llmProvider, model: 'm',
  });
  assert.ok(capture.sys.includes('COOL_STANDARD_TOKEN'), 'codingStandards in system prompt');
  assert.ok(capture.sys.includes('COOL_CONTEXT_TOKEN'), 'projectContext in system prompt');
});

