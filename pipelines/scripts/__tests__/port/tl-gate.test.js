// @ts-check
'use strict';
const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('../../lib/port/tl-gate.js');
const { ConfigError } = require('../../lib/errors.js');

const MARKER = '<!-- ai-review:v1:tl-gate -->';
/** What the note actually carries: the shared slot marker plus the on-state. */
const NOTE_BODY = `${MARKER}\n<!-- ai-review:v1:tl-on -->`;

/** A temp cwd holding (or not holding) a config file. */
function tmpCwd(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-gate-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

/**
 * A provider stub with only what the gate touches. `targetFiles` maps a config
 * path to the raw content the target branch holds; anything else is a 404.
 */
function fakeProvider(over = {}) {
  const calls = { trigger: 0, findBotComment: [], upsert: [], getFileContent: [] };
  const p = {
    calls,
    getFileContent: async (filePath, ref) => {
      calls.getFileContent.push({ filePath, ref });
      const raw = over.targetFiles?.[filePath];
      if (raw === undefined) return null;
      return raw;
    },
    getTriggerInfo: async () => {
      calls.trigger += 1;
      return over.trigger ?? { manual: false, actorId: null, actorLabel: null, howToTurnOn: 'press it' };
    },
    findBotComment: async (key) => {
      calls.findBotComment.push(key);
      // Honour the key, the way a platform does: a lookup for one marker key must
      // not be answered by a comment that carries a different one.
      const note = over.note ?? null;
      if (!note || !String(note.body).includes(`ai-review:v1:${key}`)) return null;
      return note;
    },
    upsertSummaryComment: async (key, body) => {
      calls.upsert.push({ key, body });
      return { id: '1', action: 'created' };
    },
    renderSummaryMarker: (key) => `<!-- ai-review:v1:${key} -->`,
  };
  return p;
}

/** The four cases the issue names, driven through `evaluate`. */
const ON_YAML = 'review:\n  tlGate:\n    enabled: true\n    leads: ["12345", "99"]\n';

describe('tl-gate: config path resolution', () => {
  it('uses --config= verbatim when given', () => {
    const dir = tmpCwd();
    assert.equal(gate.resolveConfigPath(dir, { configPath: 'ci/ai-review.config.yaml' }), 'ci/ai-review.config.yaml');
  });

  it('prefers .yaml over .yml, mirroring config-merge.js', () => {
    const dir = tmpCwd({
      'ai-review.config.yaml': 'review: {}\n',
      'ai-review.config.yml': 'review: {}\n',
    });
    assert.equal(gate.resolveConfigPath(dir, {}), 'ai-review.config.yaml');
  });

  it('falls back to .yml when that is the only file', () => {
    const dir = tmpCwd({ 'ai-review.config.yml': 'review: {}\n' });
    assert.equal(gate.resolveConfigPath(dir, {}), 'ai-review.config.yml');
  });

  it('falls back to the primary default when there is no config at all', () => {
    const dir = tmpCwd();
    assert.equal(gate.resolveConfigPath(dir, {}), 'ai-review.config.yaml');
  });
});

describe('tl-gate: parseGateConfig', () => {
  it('treats a missing block as off', () => {
    assert.deepEqual(gate.parseGateConfig({ review: { strict: true } }, 'c.yaml'), { enabled: false, leads: [] });
  });

  it('treats a missing review section as off', () => {
    assert.deepEqual(gate.parseGateConfig({}, 'c.yaml'), { enabled: false, leads: [] });
  });

  it('reads enabled and leads', () => {
    assert.deepEqual(gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: ['1'] } } }, 'c.yaml'),
      { enabled: true, leads: ['1'] });
  });

  it('stringifies numeric ids, because that is how GitHub, GitLab and Azure report them', () => {
    assert.deepEqual(gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: [12345, 67890] } } }, 'c.yaml'),
      { enabled: true, leads: ['12345', '67890'] });
  });

  it('keeps a braced Bitbucket UUID as written', () => {
    assert.deepEqual(gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: ['{abc-123}'] } } }, 'c.yaml'),
      { enabled: true, leads: ['{abc-123}'] });
  });

  it('a quoted "true" is a ConfigError: a mistyped switch must not silently read as off', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: { enabled: 'true', leads: ['1'] } } }, 'c.yaml'), ConfigError);
  });

  it('enabled:true with leads present reads as on', () => {
    assert.equal(gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: ['1'] } } }, 'c.yaml').enabled, true);
  });

  it('enabled with an empty leads list is a ConfigError (exit 2): nobody could turn the AI on', () => {
    assert.throws(
      () => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: [] } } }, 'c.yaml'),
      (e) => e instanceof ConfigError && /leads is empty/.test(e.message),
    );
  });

  it('enabled with no leads key at all is the same ConfigError', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: { enabled: true } } }, 'c.yaml'), ConfigError);
  });

  it('enabled:false with an empty list is fine — the gate is off, nobody is needed', () => {
    assert.deepEqual(gate.parseGateConfig({ review: { tlGate: { enabled: false, leads: [] } } }, 'c.yaml'),
      { enabled: false, leads: [] });
  });

  it('a non-boolean enabled is a ConfigError, not a silent off', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: { enabled: 1, leads: ['1'] } } }, 'c.yaml'), ConfigError);
  });

  it('a non-list leads is a ConfigError', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: 'me' } } }, 'c.yaml'), ConfigError);
  });

  it('a tlGate that is not a mapping is a ConfigError', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: ['12345'] } }, 'c.yaml'), ConfigError);
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: 'on' } }, 'c.yaml'), ConfigError);
  });

  it('a blank lead id is a ConfigError', () => {
    assert.throws(() => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: ['  '] } } }, 'c.yaml'), ConfigError);
  });

  it('a numeric lead past 2^53 is a ConfigError: YAML would hand over digits nobody wrote', () => {
    assert.throws(
      () => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: [1e21] } } }, 'c.yaml'),
      (e) => e instanceof ConfigError && /not a safe integer/.test(e.message),
    );
  });

  it('a fractional lead is the same ConfigError: no account has id 12.5', () => {
    assert.throws(
      () => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: [12.5] } } }, 'c.yaml'),
      (e) => e instanceof ConfigError && /not a safe integer/.test(e.message),
    );
  });

  it('NaN and the infinities are ConfigErrors too, and the message names the value it got', () => {
    // js-yaml resolves YAML `.nan` / `.inf` / `-.inf` to these numbers; none of
    // them reaches String(id), and none may quietly become a lead named "NaN".
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(
        () => gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: [bad] } } }, 'c.yaml'),
        (e) =>
          e instanceof ConfigError &&
          e.message.includes(`${String(bad)} is not a safe integer`),
        `accepted ${String(bad)}`,
      );
    }
  });

  it('the same ids as quoted strings still pass — the string form is what the platforms report', () => {
    assert.deepEqual(
      gate.parseGateConfig({ review: { tlGate: { enabled: true, leads: ['12345', '9007199254740993'] } } }, 'c.yaml'),
      { enabled: true, leads: ['12345', '9007199254740993'] },
    );
  });
});

describe('tl-gate: normalizeId', () => {
  it('strips Bitbucket braces and lowercases, so both sides compare equal', () => {
    assert.equal(gate.normalizeId('{ABC-123}'), gate.normalizeId('abc-123'));
  });

  it('lowercases Azure GUIDs, whose casing differs between endpoints', () => {
    assert.equal(gate.normalizeId('{6F3A1C2E-1111-2222-3333-444455556666}'),
      gate.normalizeId('6f3a1c2e-1111-2222-3333-444455556666'));
  });

  it('keeps plain numeric ids intact', () => {
    assert.equal(gate.normalizeId(12345), '12345');
  });

  it('treats null/undefined as empty rather than "null"', () => {
    assert.equal(gate.normalizeId(null), '');
    assert.equal(gate.normalizeId(undefined), '');
  });

  it('trims padding inside the braces, so a padded "{ uuid }" on one side still matches', () => {
    assert.equal(
      gate.normalizeId('  { 6F3A1C2E-1111-2222-3333-444455556666  }  '),
      gate.normalizeId('6f3a1c2e-1111-2222-3333-444455556666'),
    );
  });
});

describe('tl-gate: evaluate — the switch off (today\u2019s behaviour)', () => {
  it('no config file on the target branch → off', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider();
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true, 'the gate is not engaged, so the run proceeds');
    assert.equal(d.reason, 'switch-off');
  });

  it('no review.tlGate block on the target branch → off', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': 'review:\n  strict: true\n' } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'switch-off');
  });

  it('reads the switch from the TARGET sha, never the working folder', async () => {
    const dir = tmpCwd({ 'ai-review.config.yaml': 'review:\n  tlGate:\n    enabled: false\n' });
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 'TARGETSHA' });
    assert.equal(d.reason, 'waiting', 'the working-folder copy says off, the target branch says on');
    assert.deepEqual(provider.calls.getFileContent, [
      { filePath: 'ai-review.config.yaml', ref: 'TARGETSHA' },
    ]);
  });

  it('a provider that cannot read files leaves the gate off without touching the trigger', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider();
    delete provider.getFileContent;
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'switch-off');
    assert.equal(provider.calls.trigger, 0);
  });

  it('an unreadable target config leaves the gate off (a read failure must not hold back a review)', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider();
    provider.getFileContent = async () => { throw new Error('502 from provider'); };
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'switch-off');
  });

  it('a target config that does not parse leaves the gate off', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': 'review:\n\ttlGate: [oops\n' } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'switch-off');
  });

  it('no target sha → off, with no trigger lookup', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: '' });
    assert.equal(d.reason, 'switch-off');
    assert.equal(provider.calls.trigger, 0);
  });

  it('does NOT resolve ${VAR} in the gate block — a PR must not interpolate its way onto the lead list', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': 'review:\n  tlGate:\n    enabled: true\n    leads: ["${LEAD_ID}"]\n' },
      trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'not-lead');
  });
});

describe('tl-gate: evaluate — the switch on', () => {
  it('no press and no note → waiting, and no LLM work happens', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'waiting');
    assert.equal(d.writeNote, false);
    assert.deepEqual(provider.calls.findBotComment, ['tl-on'],
      'the on-state is read from its own marker, not from the shared comment slot');
  });

  it('a press by a listed lead → on, and the run must write the note', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'press it' },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true);
    assert.equal(d.reason, 'lead-press');
    assert.equal(d.writeNote, true);
    assert.deepEqual(d.presser, { actorId: '12345', actorLabel: 'Ada' });
  });

  it('a press matched with the config braced / the env unbraced (Bitbucket)', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': 'review:\n  tlGate:\n    enabled: true\n    leads: ["{abc-123}"]\n' },
      trigger: { manual: true, actorId: 'ABC-123', actorLabel: null, howToTurnOn: 'x' },
    });
    assert.equal((await gate.evaluate({ provider, cwd: dir, targetSha: 's0' })).on, true);
  });

  it('a press by someone not on the list → off, with the presser named for the comment', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: '777', actorLabel: 'Bob', howToTurnOn: 'press it' },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'not-lead');
    assert.equal(d.presser.actorId, '777');
  });

  it('a press the platform reports no id for → off as unknown-pressor (never "on")', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: null, actorLabel: null, howToTurnOn: 'x' },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'unknown-pressor');
  });

  it('an unknown presser cannot hold back a PR the "AI on" note already opened', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: null, actorLabel: null, howToTurnOn: 'x' },
      note: { id: '5', body: NOTE_BODY, createdAt: '2026-10-01T00:00:00Z', editedByOther: false },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true, 'an id nobody can resolve matches no lead, but the note reviews as before');
    assert.equal(d.reason, 'note');
    assert.equal(d.writeNote, false);
  });

  it('an edited note still does not rescue a press nobody can identify', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: null, actorLabel: null, howToTurnOn: 'x' },
      note: { id: '5', body: NOTE_BODY, createdAt: '2026-10-01T00:00:00Z', editedByOther: true },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'unknown-pressor');
  });

  it('the existing note turns it on on a later push, with no press at all', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      note: { id: '5', body: NOTE_BODY, createdAt: '2026-10-01T00:00:00Z', editedByOther: false },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true);
    assert.equal(d.reason, 'note');
    assert.equal(d.writeNote, false, 'the note is already there; do not rewrite it every push');
  });

  it('a comment carrying only the slot marker is not the note', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      note: { id: '5', body: MARKER, createdAt: '', editedByOther: false },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false, 'the slot marker is on every gate comment; only tl-on means "on"');
    assert.equal(d.reason, 'waiting');
  });

  it('a note someone else edited does not count', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      note: { id: '5', body: NOTE_BODY, createdAt: '', editedByOther: true },
    });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, false);
    assert.equal(d.reason, 'waiting');
  });

  it('the note is still consulted after a non-lead press, so an open PR that is already on stays on', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: '777', actorLabel: 'Bob', howToTurnOn: 'x' },
      note: { id: '5', body: NOTE_BODY, createdAt: '', editedByOther: false },
    });
    assert.equal((await gate.evaluate({ provider, cwd: dir, targetSha: 's0' })).on, true);
  });

  it('the presser check happens before the note read — a lead press never needs a note lookup', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': ON_YAML },
      trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' },
    });
    await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.deepEqual(provider.calls.findBotComment, []);
  });

  it('a malformed tlGate block throws ConfigError rather than guessing', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({
      targetFiles: { 'ai-review.config.yaml': 'review:\n  tlGate:\n    enabled: true\n    leads: []\n' },
    });
    await assert.rejects(() => gate.evaluate({ provider, cwd: dir, targetSha: 's0' }), ConfigError);
  });
});

describe('tl-gate: publish and bodies', () => {
  const provider = fakeProvider();

  it('publishes nothing when the switch is off', async () => {
    const d = { on: false, reason: 'switch-off', presser: null, howToTurnOn: '', configPath: 'c.yaml', writeNote: false, at: new Date() };
    assert.equal(await gate.publish(provider, d), null);
    assert.equal(provider.calls.upsert.length, 0);
  });

  it('publishes nothing when an existing note already turned it on', async () => {
    const d = { on: true, reason: 'note', presser: null, howToTurnOn: '', configPath: 'c.yaml', writeNote: false, at: new Date() };
    assert.equal(await gate.publish(provider, d), null);
  });

  it('the waiting body says the AI is waiting, how to turn it on, and carries the marker', () => {
    const body = gate.buildWaitingBody(provider, { howToTurnOn: 'press **Re-run all jobs**' });
    assert.match(body, /waiting for a team lead/i);
    assert.match(body, /press \*\*Re-run all jobs\*\*/);
    assert.match(body, /A push never turns the AI on/);
    assert.ok(body.includes(MARKER), 'the waiting note must be findable by later runs');
  });

  it('the denied body names the presser and their id', () => {
    const body = gate.buildDeniedBody(provider, {
      reason: 'not-lead', presser: { actorId: '777', actorLabel: 'Bob' }, howToTurnOn: 'press it',
    });
    assert.match(body, /Bob/);
    assert.match(body, /777/);
    assert.match(body, /not in `review\.tlGate\.leads`/);
  });

  it('the denied body explains an unresolvable presser instead of accusing anyone', () => {
    const body = gate.buildDeniedBody(provider, { reason: 'unknown-pressor', presser: null, howToTurnOn: 'press it' });
    assert.match(body, /no user id for this run/);
  });

  it('the "AI on" note records who and when, and carries both markers', () => {
    const at = new Date('2026-10-05T09:00:00.000Z');
    const body = gate.buildNoteBody(provider, { actorId: '12345', actorLabel: 'Ada' }, at);
    assert.match(body, /on/);
    assert.match(body, /Ada/);
    assert.match(body, /12345/);
    assert.match(body, /2026-10-05T09:00:00\.000Z/);
    assert.ok(body.includes(MARKER), 'the slot marker, so later runs upsert this same comment');
    assert.ok(body.includes('<!-- ai-review:v1:tl-on -->'), 'the on-state, which is what later runs read');
  });

  it('the note still identifies the presser when the platform gave no display name', () => {
    const body = gate.buildNoteBody(provider, { actorId: '12345', actorLabel: null }, new Date(0));
    assert.match(body, /user id `12345`/);
  });

  it('bodyFor picks the note body for a lead press and the denied body otherwise', () => {
    const at = new Date();
    const note = gate.bodyFor(provider, { writeNote: true, reason: 'lead-press', presser: { actorId: '1', actorLabel: 'A' }, at });
    assert.match(note, /Every push from here is reviewed as usual/);
    const denied = gate.bodyFor(provider, { writeNote: false, reason: 'not-lead', presser: { actorId: '1', actorLabel: 'A' }, at });
    assert.match(denied, /did no review/);
  });

  it('renderLines hard-breaks so Bitbucket does not collapse the lines together', () => {
    const out = gate.__test__.renderLines(['one', 'two', '', 'three']);
    assert.equal(out, 'one  \ntwo\n\nthree');
  });
});

describe('tl-gate: GATE_KEY', () => {
  it('is its own marker key, not the summary (append mode writes a new summary every run)', () => {
    assert.equal(gate.GATE_KEY, 'tl-gate');
  });
});

describe('tl-gate: the bot\u2019s own gate comment is not the "AI on" note', () => {
  /**
   * A provider that remembers what the bot wrote, the way a platform does: the
   * comment a run upserts is the comment the next run's marker lookup finds.
   * Without this memory every note lookup answers from a fixture, and the one
   * case that matters most — the gate opening itself — goes untested.
   *
   * @param {any} over
   */
  function memoryProvider(over = {}) {
    const p = fakeProvider(over);
    const comments = over.comments ?? [];
    const hasKey = (body, key) => body.includes(`ai-review:v1:${key}`);
    p.findBotComment = async (key) => {
      p.calls.findBotComment.push(key);
      return comments.find((/** @type {any} */ c) => hasKey(c.body, key)) ?? null;
    };
    p.upsertSummaryComment = async (key, body) => {
      p.calls.upsert.push({ key, body });
      const hit = comments.find((/** @type {any} */ c) => hasKey(c.body, key));
      if (hit) { hit.body = body; return { id: hit.id, action: 'updated' }; }
      comments.push({ id: String(comments.length + 1), body, createdAt: '', editedByOther: false });
      return { id: '1', action: 'created' };
    };
    return p;
  }

  const target = { targetFiles: { 'ai-review.config.yaml': ON_YAML } };

  /** Two pushes in a row: run, publish what it wrote, then run again. */
  async function twice(dir, provider) {
    const first = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    await gate.publish(provider, first);
    const second = await gate.evaluate({ provider, cwd: dir, targetSha: 's1' });
    return [first, second];
  }

  it('a push, then another push: the waiting comment must not turn the AI on', async () => {
    const dir = tmpCwd();
    const provider = memoryProvider(target);
    const [first, second] = await twice(dir, provider);
    assert.equal(first.reason, 'waiting');
    assert.equal(provider.calls.upsert.length, 1, 'the first run does post the waiting comment');
    assert.equal(second.on, false, 'a push never turns the AI on, not even after the bot commented');
    assert.equal(second.reason, 'waiting');
  });

  it('a denied press comment must not turn the AI on either', async () => {
    const dir = tmpCwd();
    const provider = memoryProvider({
      ...target,
      trigger: { manual: true, actorId: '777', actorLabel: 'Bob', howToTurnOn: 'x' },
    });
    const [first, second] = await twice(dir, provider);
    assert.equal(first.reason, 'not-lead');
    assert.equal(second.on, false, 'only a lead press opens the gate');
  });

  it('the note a lead press writes does open the gate on the next push', async () => {
    const dir = tmpCwd();
    // One PR, one comment store: the press writes the note, the next push reads it.
    const comments = [];
    const onPush = memoryProvider({ ...target, comments });
    const press = await gate.evaluate({
      provider: memoryProvider({
        ...target,
        comments,
        trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' },
      }),
      cwd: dir,
      targetSha: 's0',
    });
    assert.equal(press.writeNote, true);
    await gate.publish(onPush, press);
    const next = await gate.evaluate({ provider: onPush, cwd: dir, targetSha: 's1' });
    assert.equal(next.on, true);
    assert.equal(next.reason, 'note');
  });
});

describe('tl-gate: the config filename is resolved against the target branch', () => {
  /**
   * In CI `cwd` is the PR's own checkout, so it cannot be trusted to name the
   * file the gate should read. These cases all put a *misleading* local file in
   * place and assert the gate still reads what the target branch actually has.
   */
  it('a PR that adds .yml locally cannot displace the target branch\u2019s .yaml', async () => {
    const dir = tmpCwd({ 'ai-review.config.yml': 'review: {}\n' });
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'waiting', 'the gate engaged from the target branch copy');
    assert.deepEqual(
      provider.calls.getFileContent.map((/** @type {any} */ c) => [c.filePath, c.ref]),
      [['ai-review.config.yaml', 's0']],
      'one call, the file the target branch really has'
    );
  });

  it('a PR that deletes .yaml locally cannot make the gate read .yml', async () => {
    const dir = tmpCwd({ 'ai-review.config.yml': 'review:\n  tlGate:\n    enabled: false\n' });
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.reason, 'waiting', 'the target branch\u2019s .yaml wins, not the local .yml');
  });

  it('probes both candidates and reports the switch off when the target has neither', async () => {
    const dir = tmpCwd({ 'ai-review.config.yaml': ON_YAML });
    const provider = fakeProvider({ targetFiles: {} });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true);
    assert.equal(d.reason, 'switch-off');
    assert.deepEqual(
      provider.calls.getFileContent.map((/** @type {any} */ c) => c.filePath),
      ['ai-review.config.yaml', 'ai-review.config.yml']
    );
  });

  it('--config= is probed verbatim and does not fall back to the candidates', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ci/review.yaml': ON_YAML } });
    const d = await gate.evaluate({
      provider, cwd: dir, cliFlags: { configPath: 'ci/review.yaml' }, targetSha: 's0',
    });
    assert.equal(d.reason, 'waiting');
    assert.deepEqual(provider.calls.getFileContent.map((/** @type {any} */ c) => c.filePath), ['ci/review.yaml']);
  });

  it('--config= that is absent on the target leaves the gate off rather than trying another name', async () => {
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
    const d = await gate.evaluate({
      provider, cwd: dir, cliFlags: { configPath: 'ci/nope.yaml' }, targetSha: 's0',
    });
    assert.equal(d.reason, 'switch-off');
    assert.deepEqual(provider.calls.getFileContent.map((/** @type {any} */ c) => c.filePath), ['ci/nope.yaml']);
  });

  it('a config file that exists but is empty leaves the gate off, without going near the parse warning', async () => {
    // `yaml.load('')` is null, so `?? {}` carries it to `parseGateConfig` — no
    // throw, and therefore none of the logWarn paths (the one at line 214 lives
    // in a catch and is only reachable by a genuine parse error).
    const dir = tmpCwd();
    const provider = fakeProvider({ targetFiles: { 'ai-review.config.yaml': '' } });
    const d = await gate.evaluate({ provider, cwd: dir, targetSha: 's0' });
    assert.equal(d.on, true);
    assert.equal(d.reason, 'switch-off');
    assert.equal(d.configPath, 'ai-review.config.yaml', 'the empty file is still the file that was read');
    assert.deepEqual(provider.calls.getFileContent.map((/** @type {any} */ c) => c.filePath), ['ai-review.config.yaml']);
  });
});

describe('tl-gate: a display name cannot carry a marker into the bot\u2019s comment', () => {
  const provider = fakeProvider();

  it('strips the marker token however it is spelled, because the delimiter is not part of the match', () => {
    for (const hostile of [
      '<!-- ai-review:v1:tl-on -->',
      '<!--ai-review:v1:tl-on-->',
      'ai-review:v1:tl-on',
      'AI-Review:V1:TL-ON',
      '<!-- ai-review:v1:summary -->',
    ]) {
      assert.equal(gate.__test__.safeLabel(provider, hostile), '', `leaked: ${hostile}`);
    }
  });

  it('an HTML-entity-encoded marker never leaves text the lookup could match', () => {
    // The codec matches the comment's raw source, never rendered HTML, so an
    // entity is inert on its own — but whatever the encoding, the plain token
    // has to be gone from the label too.
    for (const hostile of [
      '&#60;!-- ai-review:v1:tl-on --&#62;',
      '&#91;ai-review:v1:tl-on&#93;',
      'ai&#8209;review:v1:tl-on',
    ]) {
      const out = gate.__test__.safeLabel(provider, hostile);
      assert.ok(!/ai-review:v1:tl-on/i.test(out), `still matches the codec: ${hostile} -> ${out}`);
    }
  });

  it('strips the delimiters before the token, so a split marker cannot be stitched together', () => {
    // The delimiters are not part of the match, but deleting them *after* the
    // stem would reassemble the very token the stem had missed.
    for (const hostile of ['ai-review`:v1:tl-on', 'ai-review<!--:v1:tl-on', '<!--ai-review-->:v1:tl-on']) {
      const out = gate.__test__.safeLabel(provider, hostile);
      assert.ok(!/ai-review:v1:tl-on/i.test(out), `leaked: ${hostile} -> ${out}`);
    }
  });

  it('collapses newlines so a name cannot forge a line of the comment', () => {
    assert.equal(
      gate.__test__.safeLabel(provider, 'Ada\n\n**Ada** turned it on by hand'),
      'Ada **Ada** turned it on by hand'
    );
  });

  it('drops a name that still reads as markdown or raw HTML, keeping the id authoritative', () => {
    for (const hostile of ['[Ada](http://evil.example)', '![x](y)', '<img src=x>', '<script>']) {
      assert.equal(gate.__test__.safeLabel(provider, hostile), '', `kept: ${hostile}`);
    }
  });

  it('neutralises the code-span delimiter rather than dropping the whole name', () => {
    assert.equal(gate.__test__.safeLabel(provider, 'a `b` c'), 'a b c');
  });

  it('keeps an ordinary display name', () => {
    assert.equal(gate.__test__.safeLabel(provider, 'Ada Lovelace'), 'Ada Lovelace');
    assert.equal(gate.__test__.safeLabel(provider, '  Nguyễn Văn A  '), 'Nguyễn Văn A');
    assert.equal(gate.__test__.safeLabel(provider, null), '');
  });

  it('the denied body a hostile name produces cannot answer the "AI on?" lookup', async () => {
    const dir = tmpCwd();
    const comments = [];
    const spellings = ['<!-- ai-review:v1:tl-on -->', 'ai-review`:v1:tl-on', 'ai-review<!--:v1:tl-on'];
    for (const hostile of spellings) {
      comments.length = 0;
      const denied = await gate.evaluate({
        provider: fakeProvider({
          targetFiles: { 'ai-review.config.yaml': ON_YAML },
          comments,
          trigger: { manual: true, actorId: '777', actorLabel: hostile, howToTurnOn: 'x' },
        }),
        cwd: dir,
        targetSha: 's0',
      });
      assert.equal(denied.reason, 'not-lead');
      const body = gate.bodyFor(provider, denied);
      assert.ok(!body.includes('ai-review:v1:tl-on'), `the injected token must not survive: ${hostile}`);
      assert.match(body, /user id `777`/, 'the id is what identifies the presser');

      // The escalation itself: that body lands in the bot's own gate comment, and
      // the next push must still be waiting.
      const mem = memoryProviderWithComments(comments, {
        targetFiles: { 'ai-review.config.yaml': ON_YAML },
      });
      await gate.publish(mem, denied);
      const next = await gate.evaluate({ provider: mem, cwd: dir, targetSha: 's1' });
      assert.equal(next.on, false, `a hostile name opened the gate: ${hostile}`);
      assert.equal(next.reason, 'waiting');
    }
  });

  /** A memoryProvider whose comment store is the one the hostile run wrote into. */
  function memoryProviderWithComments(comments, over) {
    const p = fakeProvider(over);
    const hasKey = (/** @type {any} */ body, /** @type {string} */ key) =>
      String(body).includes(`ai-review:v1:${key}`);
    p.findBotComment = async (/** @type {string} */ key) => {
      p.calls.findBotComment.push(key);
      return comments.find((/** @type {any} */ c) => hasKey(c.body, key)) ?? null;
    };
    p.upsertSummaryComment = async (/** @type {string} */ key, /** @type {string} */ body) => {
      p.calls.upsert.push({ key, body });
      comments.push({ id: '1', body, createdAt: '', editedByOther: false });
      return { id: '1', action: 'created' };
    };
    return p;
  }
});

describe('tl-gate: a user id cannot carry a marker into the bot\u2019s comment', () => {
  const provider = fakeProvider();
  const { safeId, stripMarkerTokens } = gate.__test__;
  /** True when the codec's lookup would find `key` in this text. */
  const hasKey = (/** @type {string} */ text, /** @type {string} */ key) =>
    String(text).toLowerCase().includes(`ai-review:v1:${key}`);

  it('strips the marker token however it is spelled, because the delimiter is not part of the match', () => {
    for (const hostile of [
      '<!-- ai-review:v1:tl-on -->',
      '<!--ai-review:v1:tl-on-->',
      'ai-review:v1:tl-on',
      'x ai-review:v1:tl-on',
      'AI-Review:V1:TL-ON',
      '<!-- ai-review:v1:summary -->',
    ]) {
      assert.equal(safeId(provider, hostile), '', `leaked: ${hostile}`);
    }
  });

  it('the allowlist alone is not enough: the marker prefix is made of allowlisted characters', () => {
    // Every character of this id passes `[\w{}:.-]`, so only the stem strip stops it.
    assert.match('ai-review:v1:tl-on', /^[\w{}:.-]+$/);
    assert.equal(safeId(provider, 'ai-review:v1:tl-on'), '');
  });

  it('drops disallowed characters before stripping, so removing one cannot assemble a marker', () => {
    for (const hostile of [
      'ai-r<>eview:v1:tl-on',
      'ai-r`e`view:v1:tl-on',
      'ai-r eview:v1:tl-on',
      'ai-r\neview:v1:tl-on',
      'ai-r[]eview:v1:tl-on',
    ]) {
      const out = safeId(provider, hostile);
      assert.ok(!hasKey(out, 'tl-on'), `assembled a marker: ${JSON.stringify(hostile)} -> ${out}`);
      assert.ok(!hasKey(out, 'tl-gate'), `assembled a marker: ${JSON.stringify(hostile)} -> ${out}`);
    }
  });

  it('removing one marker token cannot splice its neighbours into a new one', () => {
    for (const hostile of [
      'ai-ai-review:v1review:v1',
      'ai-ai-ai-review:v1review:v1review:v1',
      'ai-re{ai-review:v1}view:v1',
    ]) {
      const out = safeId(provider, hostile);
      assert.ok(!/ai-review:v1/i.test(out), `spliced: ${hostile} -> ${out}`);
    }
  });

  it('stripMarkerTokens repeats until stable', () => {
    const out = stripMarkerTokens(provider, 'ai-ai-review:v1review:v1');
    assert.ok(!/ai-review:v1/i.test(out), `left a token: ${out}`);
  });

  it('stripMarkerTokens leaves text alone when the provider has no marker prefix to probe', () => {
    const noStem = { renderSummaryMarker: () => '' };
    assert.equal(stripMarkerTokens(noStem, 'ai-review:v1:tl-on'), 'ai-review:v1:tl-on');
  });

  it('drops characters outside [\\w{}:.-], including markdown, HTML and code-span delimiters', () => {
    assert.equal(safeId(provider, '1`2\n3[x](y)<b>'), '123xyb');
    assert.equal(safeId(provider, '12 34'), '1234');
  });

  it('caps the length, so an id cannot flood the comment', () => {
    assert.equal(safeId(provider, '7'.repeat(500)).length, 128);
  });

  it('returns an empty string when there is no id', () => {
    assert.equal(safeId(provider, null), '');
    assert.equal(safeId(provider, undefined), '');
    assert.equal(safeId(provider, ''), '');
    assert.equal(safeId(provider, '   '), '');
  });

  it('keeps every real id shape unchanged', () => {
    for (const id of [
      '12345',                                      // GitHub / GitLab numeric
      '{3f2a9c1e-7b4d-4e0a-9d51-0c8e6a2b1f77}',     // Bitbucket UUID, braces and all
      '3F2A9C1E-7B4D-4E0A-9D51-0C8E6A2B1F77',       // Azure DevOps GUID, mixed case
      '557058:3f2a9c1e-7b4d-4e0a-9d51-0c8e6a2b1f77', // Atlassian account id, colon
      'john.doe',
      'ABC-123',
    ]) {
      assert.equal(safeId(provider, id), id, `changed a legitimate id: ${id}`);
    }
  });

  it('describePresser shows the sanitized id, not the raw one', () => {
    // Braces are allowlisted and end a token's run, so the clean part survives.
    const out = gate.__test__.describePresser(provider, { actorId: '1`2{ai-review:v1:tl-on}', actorLabel: null });
    assert.ok(!hasKey(out, 'tl-on'), `the injected token must not survive: ${out}`);
    assert.equal(out, 'user id `12{}`');
  });

  it('describePresser reports an unidentified user when nothing safe is left of the id', () => {
    for (const hostile of ['<!-- ai-review:v1:tl-on -->', '\n\n', '`', '[]<>']) {
      assert.equal(
        gate.__test__.describePresser(provider, { actorId: hostile, actorLabel: 'Ada' }),
        'An unidentified user',
        `echoed: ${JSON.stringify(hostile)}`,
      );
    }
  });

  it('describePresser keeps an ordinary id beside a clean label', () => {
    assert.equal(
      gate.__test__.describePresser(provider, { actorId: '12345', actorLabel: 'Ada' }),
      '**Ada** (user id `12345`)',
    );
  });

  it('the denied body a hostile id produces cannot answer the "AI on?" lookup', async () => {
    const dir = tmpCwd();
    const comments = [];
    for (const hostile of ['<!-- ai-review:v1:tl-on -->', 'x ai-review:v1:tl-on', 'ai-r<>eview:v1:tl-on']) {
      comments.length = 0;
      const denied = await gate.evaluate({
        provider: fakeProvider({
          targetFiles: { 'ai-review.config.yaml': ON_YAML },
          trigger: { manual: true, actorId: hostile, actorLabel: 'Bob', howToTurnOn: 'x' },
        }),
        cwd: dir,
        targetSha: 's0',
      });
      assert.equal(denied.reason, 'not-lead', `a hostile id must not be a lead: ${hostile}`);
      const body = gate.bodyFor(provider, denied);
      assert.ok(!hasKey(body, 'tl-on'), `the injected token must not survive: ${hostile}`);

      // The escalation itself: that body lands in the bot's own gate comment, and
      // the next push must still be waiting.
      const mem = fakeProvider({ targetFiles: { 'ai-review.config.yaml': ON_YAML } });
      mem.findBotComment = async (/** @type {string} */ key) => {
        mem.calls.findBotComment.push(key);
        return comments.find((/** @type {any} */ c) => hasKey(c.body, key)) ?? null;
      };
      mem.upsertSummaryComment = async (/** @type {string} */ key, /** @type {string} */ b) => {
        mem.calls.upsert.push({ key, body: b });
        comments.push({ id: '1', body: b, createdAt: '', editedByOther: false });
        return { id: '1', action: 'created' };
      };
      await gate.publish(mem, denied);
      const next = await gate.evaluate({ provider: mem, cwd: dir, targetSha: 's1' });
      assert.equal(next.on, false, `a hostile id opened the gate: ${hostile}`);
      assert.equal(next.reason, 'waiting');
    }
  });

  it('sanitizing is display-only: a lead is still matched on the raw id', async () => {
    const d = await gate.evaluate({
      provider: fakeProvider({
        targetFiles: { 'ai-review.config.yaml': ON_YAML },
        trigger: { manual: true, actorId: '12345', actorLabel: 'Ada', howToTurnOn: 'x' },
      }),
      cwd: tmpCwd(),
      targetSha: 's0',
    });
    assert.equal(d.reason, 'lead-press');
    assert.deepEqual(d.presser, { actorId: '12345', actorLabel: 'Ada' });
  });
});
