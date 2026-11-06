// @ts-check
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildProposal } = require('../../lib/port/learn-port.js');

const items = [
  { fingerprint: 'a', category: 'style', findingBody: 'f1', devReply: 'd1', author: 'dev1', prId: '1', prUrl: 'u1' },
  { fingerprint: 'b', category: 'style', findingBody: 'f2', devReply: 'd2', author: 'dev2', prId: '2', prUrl: 'u2' },
];

function deps({ harvested = items, clusters }) {
  return {
    harvestWontfix: async () => harvested,
    clusterPatterns: async () => clusters,
  };
}

describe('buildProposal', () => {
  const cfgLearn = { minWontfix: 2, minDistinctAuthors: 1 };

  it('returns null when no items harvested', async () => {
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: '# S\n', ignoreText: '',
      deps: deps({ harvested: [], clusters: [] }),
    });
    assert.equal(res.rules, null);
  });

  it('attributes empty-author items to their PR for distinctAuthors', async () => {
    // Two items, both with no author (UI-only resolution), from distinct PRs.
    const harvested = [
      { fingerprint: 'a', category: 'style', findingBody: 'f1', devReply: '', author: '', prId: '1', prUrl: 'u1' },
      { fingerprint: 'b', category: 'style', findingBody: 'f2', devReply: '', author: '', prId: '2', prUrl: 'u2' },
    ];
    const clusters = [{ rule: 'R', rationale: 'x', category: 'style', itemIndexes: [0, 1] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn: { minWontfix: 2, minDistinctAuthors: 2 },
      standardsText: '# S\n', ignoreText: '',
      deps: deps({ harvested, clusters }),
    });
    // distinctAuthors derived from the two distinct PRs → meets the minDistinctAuthors:2 gate.
    assert.equal(res.rules.length, 1);
  });

  it('promotes a 2-item cluster and renders newContent', async () => {
    const clusters = [{ rule: 'Allow trailing commas', rationale: 'team', category: 'style', itemIndexes: [0, 1] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: '# S\nhuman\n', ignoreText: '',
      deps: deps({ clusters }),
    });
    assert.equal(res.rules.length, 1);
    assert.deepEqual(res.rules[0].evidencePrs, ['1', '2']);
    assert.ok(res.newContent.includes('Allow trailing commas'));
    assert.ok(res.newContent.startsWith('# S\nhuman\n'));
  });

  it('returns null when the only cluster is below threshold', async () => {
    const clusters = [{ rule: 'r', rationale: '', category: 'style', itemIndexes: [0] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: '# S\n', ignoreText: '',
      deps: deps({ clusters }),
    });
    assert.equal(res.rules, null);
  });

  it('returns null when all clusters dedup against existing standards', async () => {
    const { renderLearnedBlock } = require('../../lib/learn/standards-block.js');
    const existing = `# S\n${renderLearnedBlock([{ category: 'style', rule: 'Allow trailing commas', evidencePrs: [] }])}`;
    const clusters = [{ rule: 'Allow trailing commas', rationale: '', category: 'style', itemIndexes: [0, 1] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: existing, ignoreText: '',
      deps: deps({ clusters }),
    });
    assert.equal(res.rules, null);
  });

  it('keeps a security-labeled cluster and proposes it like any other category', async () => {
    const clusters = [{ rule: 'Allow raw SQL in migrations', rationale: 'team', category: 'security', itemIndexes: [0, 1] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: '# S\n', ignoreText: '',
      deps: deps({ clusters }),
    });
    assert.notEqual(res.rules, null);
    assert.match(res.newContent ?? JSON.stringify(res), /Allow raw SQL in migrations/);
  });

  it('preserves existing learned rules and appends novel', async () => {
    const { renderLearnedBlock } = require('../../lib/learn/standards-block.js');
    const existing = `# S\n${renderLearnedBlock([{ category: 'naming', rule: 'Use camelCase', evidencePrs: ['7'] }])}`;
    const clusters = [{ rule: 'Allow trailing commas', rationale: 'team', category: 'style', itemIndexes: [0, 1] }];
    const res = await buildProposal({
      provider: {}, llmProvider: {}, model: 'm', cfgLearn,
      standardsText: existing, ignoreText: '',
      deps: deps({ clusters }),
    });
    assert.ok(res.newContent.includes('Use camelCase'));   // preserved
    assert.ok(res.newContent.includes('Allow trailing commas')); // appended
  });
});
