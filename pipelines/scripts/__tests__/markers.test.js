// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMarkers, serializeMarker, serializeKeyMarker, restyleKeyMarkers, hasMarker,
} = require('../lib/markers.js');
const { fingerprint } = require('../lib/fingerprint.js');

describe('parseMarkers', () => {
  it('extracts status marker', () => {
    const body = 'AI finding text\n\n<!-- ai-review:v1:wontfix -->';
    assert.deepEqual(parseMarkers(body, 'ai-review'), {
      status: 'wontfix',
      version: 'v1',
      fingerprint: null,
    });
  });

  it('extracts fingerprint marker', () => {
    const body = 'x\n<!-- ai-review:fingerprint=abc123 -->';
    assert.equal(parseMarkers(body, 'ai-review').fingerprint, 'abc123');
  });

  it('style="html" ignores inline-code markers (GitHub human-spoof guard)', () => {
    // A human-typed backtick marker must NOT be parsed as a real bot marker.
    const body = 'quoting the bot: `ai-review:v1:fixed` `ai-review:fingerprint=abc123`';
    assert.deepEqual(parseMarkers(body, 'ai-review', 'html'), {
      status: null, version: null, fingerprint: null,
    });
    // The default ('both') still reads the inline-code form (Bitbucket).
    assert.equal(parseMarkers(body, 'ai-review').status, 'fixed');
  });

  it('style="html" still reads HTML-comment markers', () => {
    const body = 'x\n<!-- ai-review:v1:wontfix -->';
    assert.equal(parseMarkers(body, 'ai-review', 'html').status, 'wontfix');
  });

  it('returns nulls when no markers', () => {
    assert.deepEqual(parseMarkers('plain comment', 'ai-review'), {
      status: null,
      version: null,
      fingerprint: null,
    });
  });

  it('ignores markers with wrong prefix', () => {
    const body = '<!-- other-bot:v1:fixed -->';
    assert.equal(parseMarkers(body, 'ai-review').status, null);
  });

  it('parses last status marker if multiple present', () => {
    const body = '<!-- ai-review:v1:active -->\n<!-- ai-review:v1:fixed -->';
    assert.equal(parseMarkers(body, 'ai-review').status, 'fixed');
  });
});

describe('serializeMarker', () => {
  it('formats status + fingerprint markers', () => {
    const out = serializeMarker({ prefix: 'ai-review', status: 'fixed', fingerprintHash: 'deadbeef' });
    assert.match(out, /<!-- ai-review:v1:fixed -->/);
    assert.match(out, /<!-- ai-review:fingerprint=deadbeef -->/);
  });

  it('omits fingerprint when not provided', () => {
    const out = serializeMarker({ prefix: 'ai-review', status: 'wontfix' });
    assert.match(out, /<!-- ai-review:v1:wontfix -->/);
    assert.equal(/fingerprint=/.test(out), false);
  });
});

describe('serializeMarker — bitbucket style', () => {
  it('emits inline-code status + fingerprint', () => {
    const out = serializeMarker({
      prefix: 'ai-review', status: 'fixed', fingerprintHash: 'deadbeef', style: 'bitbucket',
    });
    assert.match(out, /`ai-review:v1:fixed`/);
    assert.match(out, /`ai-review:fingerprint=deadbeef`/);
    assert.equal(/<!--/.test(out), false);
  });

  it('defaults to html style when style omitted', () => {
    const out = serializeMarker({ prefix: 'ai-review', status: 'active' });
    assert.match(out, /<!-- ai-review:v1:active -->/);
  });
});

describe('serializeKeyMarker', () => {
  it('emits HTML-comment key marker by default', () => {
    assert.equal(serializeKeyMarker({ prefix: 'ai-review', key: 'summary' }), '<!-- ai-review:v1:summary -->');
  });
  it('emits inline-code key marker for bitbucket style', () => {
    assert.equal(
      serializeKeyMarker({ prefix: 'ai-review', key: 'summary', style: 'bitbucket' }),
      '`ai-review:v1:summary`',
    );
  });
});

describe('restyleKeyMarkers', () => {
  it('rewrites HTML key markers to inline-code for bitbucket style', () => {
    const body = '### Summary\n\n<!-- ai-review:v1:summary -->';
    assert.equal(restyleKeyMarkers(body, 'ai-review', 'bitbucket'), '### Summary\n\n`ai-review:v1:summary`');
  });
  it('is a no-op for html style', () => {
    const body = '<!-- ai-review:v1:summary -->';
    assert.equal(restyleKeyMarkers(body, 'ai-review', 'html'), body);
  });
  it('leaves fingerprint markers untouched (only key markers restyled)', () => {
    const body = '<!-- ai-review:fingerprint=deadbeef -->';
    assert.equal(restyleKeyMarkers(body, 'ai-review', 'bitbucket'), body);
  });
  it('result is still parseable as a marker (round-trips through hasMarker)', () => {
    const out = restyleKeyMarkers('<!-- ai-review:v1:summary -->', 'ai-review', 'bitbucket');
    assert.equal(hasMarker(out, 'ai-review'), true);
  });
});

describe('parseMarkers — cross-style', () => {
  it('parses inline-code status marker', () => {
    const body = 'finding\n\n`ai-review:v1:wontfix`';
    assert.equal(parseMarkers(body, 'ai-review').status, 'wontfix');
  });

  it('parses inline-code fingerprint marker', () => {
    const body = 'x\n`ai-review:fingerprint=abc123`';
    assert.equal(parseMarkers(body, 'ai-review').fingerprint, 'abc123');
  });

  it('parses a mix of html and inline-code in one body (last-wins)', () => {
    const body = '<!-- ai-review:v1:active -->\n`ai-review:v1:fixed`';
    assert.equal(parseMarkers(body, 'ai-review').status, 'fixed');
  });
});

describe('hasMarker', () => {
  it('detects a status marker (html or inline-code)', () => {
    assert.equal(hasMarker('x <!-- ai-review:v1:active -->', 'ai-review'), true);
    assert.equal(hasMarker('x `ai-review:v1:fixed`', 'ai-review'), true);
  });
  it('detects a summary marker', () => {
    assert.equal(hasMarker('body <!-- ai-review:v1:summary -->', 'ai-review'), true);
  });
  it('detects a fingerprint marker', () => {
    assert.equal(hasMarker('x `ai-review:fingerprint=deadbeef`', 'ai-review'), true);
  });
  it('returns false for a body with no marker', () => {
    assert.equal(hasMarker('just a normal comment', 'ai-review'), false);
    assert.equal(hasMarker('', 'ai-review'), false);
  });
  it('ignores a different prefix', () => {
    assert.equal(hasMarker('<!-- other-bot:v1:active -->', 'ai-review'), false);
  });
});

describe('fingerprint', () => {
  it('is stable for same inputs', () => {
    assert.equal(fingerprint('a.ts', 5, 'rule-x'), fingerprint('a.ts', 5, 'rule-x'));
  });
  it('differs across rules', () => {
    assert.notEqual(fingerprint('a.ts', 5, 'rule-x'), fingerprint('a.ts', 5, 'rule-y'));
  });
  it('returns hex string of fixed length', () => {
    const fp = fingerprint('a.ts', 5, 'rule-x');
    assert.match(fp, /^[a-f0-9]+$/);
    assert.equal(fp.length, 16);
  });
});

describe('getRegexes cache', () => {
  it('caches compiled regexes per (style, prefix)', () => {
    const { getRegexes } = require('../lib/markers.js').__test__;
    const html = getRegexes('cache-probe', 'html');
    assert.equal(getRegexes('cache-probe', 'html'), html, 'second call must hit the cache');
    const both = getRegexes('cache-probe', 'both');
    assert.notEqual(both, html, 'styles must not share a cache entry');
    assert.equal(getRegexes('cache-probe', 'both'), both);
  });
});
