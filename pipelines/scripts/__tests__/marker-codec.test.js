// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeMarkerCodec, STATUS_REPLY_TEXT } = require('../lib/marker-codec.js');

describe('makeMarkerCodec — html style', () => {
  const codec = makeMarkerCodec({ prefix: 'ai-review', style: 'html' });

  it('renders status + fingerprint as HTML comments', () => {
    const out = codec.status('fixed', 'deadbeef');
    assert.match(out, /<!-- ai-review:v1:fixed -->/);
    assert.match(out, /<!-- ai-review:fingerprint=deadbeef -->/);
  });

  it('renders a key marker as an HTML comment', () => {
    assert.equal(codec.key('summary'), '<!-- ai-review:v1:summary -->');
  });

  it('appendStatus / appendKey separate body from marker with a blank line', () => {
    assert.equal(codec.appendStatus('B', 'active'), 'B\n\n<!-- ai-review:v1:active -->');
    assert.equal(codec.appendKey('B', 'verdict'), 'B\n\n<!-- ai-review:v1:verdict -->');
  });

  it('statusReplyText pulls shared prose; statusReplyBody adds the marker', () => {
    assert.equal(codec.statusReplyText('fixed'), STATUS_REPLY_TEXT.fixed);
    assert.match(codec.statusReplyBody('fixed'), /<!-- ai-review:v1:fixed -->$/);
  });

  it('statusReplyText falls back for unknown status', () => {
    assert.equal(codec.statusReplyText('weird'), '_Status: weird._');
  });

  it('restyle is a no-op for html', () => {
    const b = 'x\n\n<!-- ai-review:v1:summary -->';
    assert.equal(codec.restyle(b), b);
  });
});

describe('makeMarkerCodec — bitbucket style (literal)', () => {
  const codec = makeMarkerCodec({ prefix: 'ai-review', style: 'bitbucket' });

  it('renders markers as inline-code', () => {
    assert.equal(codec.key('summary'), '`ai-review:v1:summary`');
    assert.match(codec.status('active'), /`ai-review:v1:active`/);
  });

  it('restyle rewrites HTML key markers to inline-code', () => {
    assert.equal(codec.restyle('<!-- ai-review:v1:summary -->'), '`ai-review:v1:summary`');
  });
});

describe('makeMarkerCodec — lazy style thunk', () => {
  it('reads the live style on each call (mirrors Bitbucket probe resolution)', () => {
    let style = /** @type {'html'|'bitbucket'} */ ('bitbucket');
    const codec = makeMarkerCodec({ prefix: 'ai-review', style: () => style });
    assert.equal(codec.key('summary'), '`ai-review:v1:summary`');
    style = 'html';
    assert.equal(codec.key('summary'), '<!-- ai-review:v1:summary -->');
    assert.equal(codec.style(), 'html');
  });
});

describe('makeMarkerCodec — parsing', () => {
  const codec = makeMarkerCodec({ prefix: 'ai-review', style: 'html' });

  it('parse reads status + fingerprint in either wire form', () => {
    assert.equal(codec.parse('`ai-review:v1:wontfix`').status, 'wontfix');
    assert.equal(codec.parse('<!-- ai-review:v1:fixed -->').status, 'fixed');
  });

  it('has detects any of our markers', () => {
    assert.equal(codec.has('text `ai-review:v1:summary`'), true);
    assert.equal(codec.has('plain'), false);
  });

  it('hasKey matches the exact key in either wire form, with boundary safety', () => {
    assert.equal(codec.hasKey('<!-- ai-review:v1:summary -->', 'summary'), true);
    assert.equal(codec.hasKey('`ai-review:v1:summary`', 'summary'), true);
    // boundary: `summary` must not match `summary-extended` and vice-versa
    assert.equal(codec.hasKey('`ai-review:v1:summary-extended`', 'summary'), false);
    assert.equal(codec.hasKey('`ai-review:v1:summary`', 'summary-extended'), false);
  });

  it('respects a custom prefix', () => {
    const c2 = makeMarkerCodec({ prefix: 'bot-x', style: 'html' });
    assert.equal(c2.key('summary'), '<!-- bot-x:v1:summary -->');
    assert.equal(c2.hasKey('<!-- ai-review:v1:summary -->', 'summary'), false);
  });
});
