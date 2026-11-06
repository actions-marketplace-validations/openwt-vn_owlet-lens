// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { IReviewProvider, defaultCapabilities } = require('../../lib/providers/provider.types.js');

describe('provider learn surface', () => {
  it('defaultCapabilities.canProposeChanges is false', () => {
    assert.equal(defaultCapabilities().canProposeChanges, false);
  });
  it('new methods throw NotImplemented by default', async () => {
    const p = new IReviewProvider();
    await assert.rejects(() => p.listMergedPRs({ sinceISO: 'x' }), /listMergedPRs/);
    await assert.rejects(() => p.listThreadsForPR('1'), /listThreadsForPR/);
    await assert.rejects(() => p.proposeStandardsChange({}), /proposeStandardsChange/);
  });
});
