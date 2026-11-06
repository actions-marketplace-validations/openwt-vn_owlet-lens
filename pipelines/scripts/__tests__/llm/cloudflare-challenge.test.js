// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCloudflareChallenge } = require('../../lib/llm/base.js');

test('cloudflare: cf-mitigated header is sufficient', () => {
  assert.equal(isCloudflareChallenge({ cfMitigated: 'challenge' }), true);
});

test('cloudflare: blank cf-mitigated header is ignored', () => {
  assert.equal(isCloudflareChallenge({ cfMitigated: '   ' }), false);
  assert.equal(isCloudflareChallenge({ cfMitigated: null }), false);
});

test('cloudflare: "Just a moment" interstitial matches via body marker', () => {
  const body = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';
  assert.equal(isCloudflareChallenge({ contentType: 'text/html', body }), true);
});

test('cloudflare: "Attention Required" block page matches', () => {
  assert.equal(isCloudflareChallenge({ body: 'Attention Required! | Cloudflare' }), true);
});

test('cloudflare: cf-ray marker matches even without content-type', () => {
  assert.equal(isCloudflareChallenge({ body: 'error cf-ray: 8abc' }), true);
});

test('cloudflare: html page naming cloudflare without strong marker matches', () => {
  assert.equal(
    isCloudflareChallenge({ contentType: 'text/html; charset=UTF-8', body: 'Powered by Cloudflare' }),
    true,
  );
});

test('cloudflare: body naming cloudflare without an HTML content-type does NOT match', () => {
  // Guards the html-content-type gate on line 60: the weak /cloudflare/ marker
  // only counts when the response is actually HTML. A JSON body that merely
  // mentions Cloudflare must not be misread as a challenge.
  assert.equal(
    isCloudflareChallenge({ contentType: 'application/json', body: 'Powered by Cloudflare' }),
    false,
  );
});

test('cloudflare: genuine JSON invalid_api_key 403 does NOT match', () => {
  assert.equal(
    isCloudflareChallenge({ contentType: 'application/json', body: '{"error":"invalid_api_key"}' }),
    false,
  );
});

test('cloudflare: plain-text forbidden does NOT match', () => {
  assert.equal(isCloudflareChallenge({ contentType: 'text/plain', body: 'Forbidden' }), false);
});

test('cloudflare: empty args do NOT match', () => {
  assert.equal(isCloudflareChallenge(), false);
  assert.equal(isCloudflareChallenge({}), false);
});
