// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');

const { runInit } = require('../lib/init.js');

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-init-test-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function fakeStdin(lines) {
  const r = new Readable({ read() {} });
  r.isTTY = true;
  let i = 0;
  const feed = () => {
    if (i < lines.length) {
      r.push(lines[i++] + '\n');
      setTimeout(feed, 5);
    } else {
      r.push(null);
    }
  };
  setTimeout(feed, 5);
  return r;
}

function captureStdout() {
  let buf = '';
  const w = new Writable({ write(chunk, _enc, cb) { buf += chunk.toString(); cb(); } });
  return { stream: w, text() { return buf; } };
}

test('init: generates config with anthropic defaults', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: github'));
    assert.ok(cfg.includes('provider: anthropic'));
    assert.ok(cfg.includes('model: claude-sonnet-4-20250514'));
    assert.ok(cfg.includes('model: claude-haiku-4-5-20251001'));
    assert.ok(cfg.includes('anthropicKey: ${ANTHROPIC_API_KEY}'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: generates config with gemini provider', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: gemini'));
    assert.ok(cfg.includes('geminiKey: ${GEMINI_API_KEY}'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: unknown LLM provider falls back to anthropic', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['github', 'bogus', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    assert.ok(out.text().includes("Unknown LLM provider 'bogus'"));
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('provider: anthropic'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: includes codingStandardsPath when provided', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', './standards.md', 'n']),
      stdout: out.stream,
      cwd,
    });
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(cfg.includes('codingStandardsPath: "./standards.md"'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: omits codingStandardsPath when empty', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    const cfg = fs.readFileSync(path.join(cwd, 'ai-review.config.yaml'), 'utf8');
    assert.ok(!cfg.includes('codingStandardsPath'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: backs up existing config on overwrite', async () => {
  const cwd = makeTmpDir();
  try {
    const configPath = path.join(cwd, 'ai-review.config.yaml');
    fs.writeFileSync(configPath, 'old: true\n');
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['y', 'github', 'anthropic', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    const bakFiles = fs.readdirSync(cwd).filter(f => f.startsWith('ai-review.config.yaml.') && f.endsWith('.bak'));
    assert.ok(bakFiles.length >= 1, 'timestamped backup should exist');
    assert.equal(fs.readFileSync(path.join(cwd, bakFiles[0]), 'utf8'), 'old: true\n');
    const cfg = fs.readFileSync(configPath, 'utf8');
    assert.ok(cfg.includes('provider: anthropic'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: keeps existing config when user declines overwrite', async () => {
  const cwd = makeTmpDir();
  try {
    const configPath = path.join(cwd, 'ai-review.config.yaml');
    fs.writeFileSync(configPath, 'old: true\n');
    const out = captureStdout();
    const code = await runInit({
      stdin: fakeStdin(['n']),
      stdout: out.stream,
      cwd,
    });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'old: true\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: skips hook when not a git repo', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-init-nogit-'));
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'anthropic', '', '', '', '']),
      stdout: out.stream,
      cwd,
    });
    assert.ok(out.text().includes('Not a git repository'));
    assert.ok(!fs.existsSync(path.join(cwd, '.githooks')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init: prints next steps with correct env var', async () => {
  const cwd = makeTmpDir();
  try {
    const out = captureStdout();
    await runInit({
      stdin: fakeStdin(['github', 'gemini', '', '', '', 'n']),
      stdout: out.stream,
      cwd,
    });
    assert.ok(out.text().includes('GEMINI_API_KEY'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
