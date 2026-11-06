// @ts-check
'use strict';

// Thread selection and status repair for the reply run, split out of
// ai-review.js so both rules are testable without a provider.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  lastDevReplyIndex, findPostedVerdict, repairVerdictStatus,
} = require('../../lib/port/reply-thread-scan.js');

const VERDICT_LINE = /_AI verdict:_\s*`(fixed|wontfix|active)`/;
const parseVerdictText = (body) => {
  const m = VERDICT_LINE.exec(body ?? '');
  const v = m?.[1];
  return v === 'fixed' || v === 'wontfix' || v === 'active' ? v : null;
};

// markers stub: a body carries the verdict key when it holds the verdict line.
const markers = {
  hasKey: (body, key) => (key === 'verdict' ? /_AI verdict:_/.test(body ?? '') : false),
};

const botVerdict = (verdict) => ({ id: 'c2', isBot: true, body: `_AI verdict:_ \`${verdict}\` — because` });
const botFinding = { id: 'c1', isBot: true, body: 'finding body' };

function fakeProvider({ patch = async () => ({}) } = {}) {
  const calls = [];
  return {
    calls,
    async patchThreadStatus(id, status) { calls.push({ id, status }); return patch(id, status); },
  };
}

// Silence the structured error line repairVerdictStatus writes on failure.
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  return { lines, restore() { process.stderr.write = orig; } };
}

describe('lastDevReplyIndex', () => {
  it('returns -1 for a bot-only thread', () => {
    assert.equal(lastDevReplyIndex({ comments: [botFinding, botVerdict('fixed')] }), -1);
  });

  it('returns the index of the last non-bot comment', () => {
    const thread = { comments: [botFinding, { id: 'c2', isBot: false }, botVerdict('fixed'), { id: 'c4', isBot: false }] };
    assert.equal(lastDevReplyIndex(thread), 3);
  });

  it('tolerates a thread with no comments array', () => {
    assert.equal(lastDevReplyIndex({}), -1);
  });
});

describe('findPostedVerdict', () => {
  it('finds the last bot verdict after the developer reply', () => {
    const thread = { comments: [botFinding, { id: 'd1', isBot: false }, botVerdict('active'), botVerdict('fixed')] };
    const found = findPostedVerdict(thread, markers, 1);
    assert.equal(found.id, 'c2');
    assert.match(found.body, /`fixed`/);
  });

  it('returns null when no verdict was posted after the reply', () => {
    const thread = { comments: [botFinding, botVerdict('fixed'), { id: 'd1', isBot: false }] };
    assert.equal(findPostedVerdict(thread, markers, 2), null);
  });

  it('ignores a dev comment that quotes the verdict line', () => {
    const thread = { comments: [botFinding, { id: 'd1', isBot: false }, { id: 'd2', isBot: false, body: '_AI verdict:_ `fixed`' }] };
    assert.equal(findPostedVerdict(thread, markers, 1), null);
  });
});

describe('repairVerdictStatus', () => {
  const thread = { id: 'T1' };

  it('applies the missing status for a written fixed/wontfix verdict', async () => {
    for (const verdict of ['fixed', 'wontfix']) {
      const provider = fakeProvider();
      const outcome = await repairVerdictStatus(thread, botVerdict(verdict), {
        provider, parseVerdictText, dryRun: false,
      });
      assert.equal(outcome, 'patched');
      assert.deepEqual(provider.calls, [{ id: 'T1', status: verdict }]);
    }
  });

  it('leaves an active verdict alone', async () => {
    const provider = fakeProvider();
    const outcome = await repairVerdictStatus(thread, botVerdict('active'), {
      provider, parseVerdictText, dryRun: false,
    });
    assert.equal(outcome, 'skipped');
    assert.deepEqual(provider.calls, []);
  });

  it('leaves an unreadable marker alone rather than guessing', async () => {
    const provider = fakeProvider();
    const outcome = await repairVerdictStatus(thread, { body: 'no verdict line here' }, {
      provider, parseVerdictText, dryRun: false,
    });
    assert.equal(outcome, 'skipped');
    assert.deepEqual(provider.calls, []);
  });

  it('does not mutate the provider on a dry run', async () => {
    const provider = fakeProvider();
    const outcome = await repairVerdictStatus(thread, botVerdict('fixed'), {
      provider, parseVerdictText, dryRun: true,
    });
    assert.equal(outcome, 'skipped');
    assert.deepEqual(provider.calls, []);
  });

  it('reports failed and logs one error line when the patch throws', async () => {
    const provider = fakeProvider({ patch: async () => { throw new Error('boom'); } });
    const stderr = captureStderr();
    try {
      const outcome = await repairVerdictStatus(thread, botVerdict('fixed'), {
        provider, parseVerdictText, dryRun: false,
      });
      assert.equal(outcome, 'failed');
      const entry = JSON.parse(stderr.lines.join('').trim());
      assert.equal(entry.msg, 'reply status repair failed');
      assert.equal(entry.threadId, 'T1');
      assert.equal(entry.verdict, 'fixed');
    } finally { stderr.restore(); }
  });
});
