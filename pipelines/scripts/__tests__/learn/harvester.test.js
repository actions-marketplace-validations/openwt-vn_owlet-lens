// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { harvestWontfix, parseCategory } = require('../../lib/learn/harvester.js');

describe('parseCategory', () => {
  it('extracts category from posted finding body', () => {
    assert.equal(parseCategory('**[LOW/style]** trailing space'), 'style');
    assert.equal(parseCategory('no marker here'), null);
  });
});

function fakeProvider(prs, threadsByPr) {
  return {
    async listMergedPRs() { return prs; },
    async listThreadsForPR(id) { return threadsByPr[id] || []; },
  };
}

const botComment = (body, email = 'bot') => ({ authorEmail: email, body, isBot: true, createdAt: '2026-06-01' });
const devComment = (body, email) => ({ authorEmail: email, body, isBot: false, createdAt: '2026-06-02' });

describe('harvestWontfix', () => {
  const prs = [{ id: '12', title: 'a', mergedAt: '', authorEmail: '', url: 'http://pr/12' }];

  it('keeps bot wontfix threads of every category, including security, drops others', async () => {
    const threadsByPr = { 12: [
      { id: 't1', status: 'wontfix', filePath: 'a.ts', line: 3,
        comments: [botComment('**[LOW/style]** nit'), devComment('disagree', 'dev1')],
        marker: { fingerprint: 'aaaa' } },
      { id: 't2', status: 'wontfix', filePath: 'b.ts', line: 9,
        comments: [botComment('**[HIGH/security]** sqli'), devComment('false positive', 'dev2')],
        marker: { fingerprint: 'bbbb' } },
      { id: 't3', status: 'active', filePath: 'c.ts', line: 1,
        comments: [botComment('**[MEDIUM/bug]** x')], marker: { fingerprint: 'cccc' } },
      { id: 't4', status: 'wontfix', filePath: 'd.ts', line: 1,
        comments: [devComment('human thread', 'dev3')], marker: {} },
    ] };
    const items = await harvestWontfix(fakeProvider(prs, threadsByPr), { sinceISO: 'x', limit: 50 });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      fingerprint: 'aaaa', category: 'style', findingBody: '**[LOW/style]** nit',
      devReply: 'disagree', author: 'dev1', prId: '12', prUrl: 'http://pr/12',
    });
    assert.deepEqual(items[1], {
      fingerprint: 'bbbb', category: 'security', findingBody: '**[HIGH/security]** sqli',
      devReply: 'false positive', author: 'dev2', prId: '12', prUrl: 'http://pr/12',
    });
  });

  it('soft-skips a PR whose listThreadsForPR throws', async () => {
    const prov = {
      async listMergedPRs() { return [{ id: '1', url: 'u' }, { id: '2', url: 'u2' }]; },
      async listThreadsForPR(id) {
        if (id === '1') throw new Error('boom');
        return [{ id: 't', status: 'wontfix', filePath: 'a', line: 1,
          comments: [botComment('**[LOW/style]** n'), devComment('d', 'e')], marker: { fingerprint: 'f1' } }];
      },
    };
    const items = await harvestWontfix(prov, { sinceISO: 'x', limit: 50 });
    assert.equal(items.length, 1);
    assert.equal(items[0].prId, '2');
  });
});
