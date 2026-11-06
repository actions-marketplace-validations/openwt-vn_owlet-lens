// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { guard } = require('../../lib/port/skip-unchanged.js');

const FP = 'a'.repeat(32);

/**
 * A Bitbucket-shaped provider: its wire style is resolved lazily, so before the
 * style probe it renders the inline-code form even when the stored summary was
 * written in the HTML-comment form (ADR-0003).
 *
 * @param {string} storedBody
 */
function bitbucketLike(storedBody) {
  return /** @type {any} */ ({
    markers: { prefix: 'ai-review' },
    renderSummaryMarker: (/** @type {string} */ k) => `\`ai-review:v1:${k}\``,
    findBotComment: async () => ({ id: '1', body: storedBody, createdAt: '', editedByOther: false }),
    getTriggerInfo: async () => ({ manual: false }),
  });
}

/** @param {any} provider */
async function skips(provider) {
  const life = { log() {}, elapsedMs: () => 0, appendState() {}, writeAudit: () => false };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    // guard returns the exit code when it skipped, null when the run reviews.
    return (await guard({
      provider, providerName: 'bitbucket', config: { review: { skipUnchanged: true, model: 'm', severityThreshold: 'medium' } },
      cliFlags: {}, env: {}, meta: /** @type {any} */ ({ id: '1' }), fingerprint: FP, tlGate: {}, life,
    })) !== null;
  } finally {
    process.stdout.write = write;
  }
}

describe('skip-unchanged marker match', () => {
  it('matches a marker stored in the other wire style', async () => {
    assert.equal(await skips(bitbucketLike(`summary\n\n<!-- ai-review:v1:reviewed-${FP} -->`)), true);
  });

  it('matches a marker stored in the provider’s current wire style', async () => {
    assert.equal(await skips(bitbucketLike(`summary\n\n\`ai-review:v1:reviewed-${FP}\``)), true);
  });

  it('does not match the key in prose', async () => {
    assert.equal(await skips(bitbucketLike(`see ai-review:v1:reviewed-${FP} in log`)), false);
  });
});
