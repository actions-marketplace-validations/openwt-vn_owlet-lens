// @ts-check
'use strict';

/**
 * TL gate. With `review.tlGate.enabled` on, a pull request gets no AI review
 * until a team lead turns the AI on for it; every push after that is reviewed
 * as usual. Off (the default) this module decides nothing.
 *
 * The gate answers "may this run spend a token?" before any LLM client is
 * built, so a held-back PR costs one config read and one comment. It lives in
 * `lib/port/` (cross-cutting over providers), not in the review pass.
 *
 *  1. The switch and lead list come from the config on the PR's TARGET branch,
 *     never the PR's own copy (ADR-0014); otherwise a PR could switch its own
 *     gate off.
 *  2. "AI on" is the `tl-on` marker in the bot's own comment (ADR-0001), so it
 *     survives every later push.
 *  3. Only a button press from a listed lead turns the AI on. A push never
 *     does, and there is no turn-off.
 *
 * Platform facts stay in each provider (ADR-0012): `getTriggerInfo()` and
 * `findBotComment()`.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { ConfigError } = require('../errors.js');
const { logWarn } = require('../log-helpers.js');
const { safeMsg } = require('../log-safe.js');

/**
 * Marker key of the bot's own gate comment: the upsert slot, so a PR carries
 * exactly one gate comment. The waiting and denied comments carry it too, so
 * reading it back must never mean "AI on".
 */
const GATE_KEY = 'tl-gate';

/**
 * Marker key that means "AI on", written only into the note a lead's press
 * creates. A legal key name (lowercase, dashes): `markers.js` only recognises
 * that shape, and Bitbucket bot detection reads marker presence.
 */
const ON_KEY = 'tl-on';

/** Config file names, in the order `config-merge.js` looks for them. */
const CONFIG_CANDIDATES = ['ai-review.config.yaml', 'ai-review.config.yml'];

/** @typedef {{ enabled: boolean, leads: string[] }} GateConfig */

/**
 * @typedef {Object} GateDecision
 * @property {boolean} on whether this run may review
 * @property {'switch-off'|'note'|'lead-press'|'waiting'|'not-lead'|'unknown-pressor'} reason
 * @property {{ actorId: string, actorLabel: string|null }|null} presser who pressed the button, when anyone did
 * @property {string} howToTurnOn the platform's one-line instructions for pressing it
 * @property {string} configPath the config file the switch was read from
 * @property {boolean} writeNote true when this run must persist the "AI on" note
 * @property {Date} at when this run decided, stamped into the note
 */

/**
 * The config file *this run* is using, for logs and reports only. The gate does
 * not decide what to read from this: in CI the working folder is the PR's own
 * checkout, so a PR could steer it onto a path the target branch lacks
 * (`readGateFromTargetBranch` resolves against the target branch; ADR-0014).
 *
 * Mirrors `config-merge.js`: `--config=`, else first local default, else primary.
 *
 * @param {string} cwd
 * @param {{ configPath?: string }} [cliFlags]
 * @returns {string}
 */
function resolveConfigPath(cwd, cliFlags) {
  const explicit = cliFlags?.configPath;
  if (explicit) return explicit;
  const found = CONFIG_CANDIDATES.find((name) => fs.existsSync(path.join(cwd, name)));
  return found ?? CONFIG_CANDIDATES[0];
}

/**
 * Validate the `review.tlGate` block. Throws ConfigError (exit 2) when it is
 * malformed: it is the operator's own switch, and guessing would silently turn
 * the gate on or off for the whole repository.
 *
 * Leads are ids, not usernames. Numeric YAML ids are accepted and stringified,
 * as GitHub, GitLab and Azure DevOps report them.
 *
 * @param {any} parsed the target branch's config document
 * @param {string} configPath for error messages
 * @returns {GateConfig}
 */
function parseGateConfig(parsed, configPath) {
  const gate = parsed?.review?.tlGate;
  if (gate == null) return { enabled: false, leads: [] };
  if (typeof gate !== 'object' || Array.isArray(gate)) {
    throw new ConfigError(
      `review.tlGate in ${configPath} must be a mapping with \`enabled\` and \`leads\` (got: ${Array.isArray(gate) ? 'list' : typeof gate})`,
    );
  }
  if (gate.enabled != null && typeof gate.enabled !== 'boolean') {
    throw new ConfigError(
      `review.tlGate.enabled in ${configPath} must be a boolean (got: ${JSON.stringify(gate.enabled)})`,
    );
  }
  const rawLeads = gate.leads ?? [];
  if (!Array.isArray(rawLeads)) {
    throw new ConfigError(
      `review.tlGate.leads in ${configPath} must be a list of user ids (got: ${typeof rawLeads})`,
    );
  }
  const leads = rawLeads.map((id) => {
    if (typeof id === 'number') {
      if (!Number.isSafeInteger(id)) {
        // An id that lost precision matches no account, so the lead would look
        // configured yet never work; String(id) prints NaN where JSON gives null.
        throw new ConfigError(
          `review.tlGate.leads entries in ${configPath} must be integer ids or their quoted string form: ${String(id)} is not a safe integer, so it cannot name an account — quote the id instead`,
        );
      }
      return String(id);
    }
    if (typeof id === 'string' && id.trim() !== '') return id.trim();
    throw new ConfigError(
      `review.tlGate.leads entries in ${configPath} must be non-empty user ids (got: ${JSON.stringify(id)})`,
    );
  });
  const enabled = gate.enabled === true;
  if (enabled && leads.length === 0) {
    throw new ConfigError(
      `review.tlGate.enabled is true in ${configPath} but review.tlGate.leads is empty — nobody could turn the AI on`,
    );
  }
  return { enabled, leads };
}

/**
 * Read the gate config from the config file on the PR's target branch.
 *
 * Deliberately not `loadConfig`: a raw YAML read with no `${VAR}` interpolation
 * and no env or CLI override, so neither a PR nor a CI variable can set the
 * lead list or flip the switch.
 *
 * Returns null (behave exactly as before) for any soft reason: no config on the
 * target branch, no `review.tlGate` block, a provider that cannot read files, or
 * a document that does not parse. A malformed `review.tlGate` block throws.
 * Candidate filenames are probed on the target branch, not the working folder.
 *
 * @param {{
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   cwd: string,
 *   cliFlags?: { configPath?: string },
 *   targetSha: string,
 * }} opts
 * @returns {Promise<{ config: GateConfig, configPath: string }|null>}
 */
async function readGateFromTargetBranch({ provider, cwd, cliFlags, targetSha }) {
  const reported = resolveConfigPath(cwd, cliFlags);
  if (!targetSha) {
    logWarn('tlGate: no target sha on the PR; reading no config, leaving the gate off', { configPath: reported });
    return null;
  }
  if (typeof provider.getFileContent !== 'function') {
    return null;
  }
  // The filename is chosen against the target branch, not the working folder (ADR-0014).
  const candidates = cliFlags?.configPath ? [cliFlags.configPath] : CONFIG_CANDIDATES;
  let configPath = null;
  let raw = null;
  for (const name of candidates) {
    try {
      raw = await provider.getFileContent(name, targetSha);
    } catch (e) {
      // A read failure must not hold back a review that would otherwise run.
      logWarn('tlGate: could not read the config on the target branch; leaving the gate off', {
        configPath: name, ref: targetSha, errMessage: safeMsg(e),
      });
      return null;
    }
    if (raw != null) { configPath = name; break; }
  }
  if (configPath === null) return null;
  /** @type {any} */
  let parsed;
  try {
    parsed = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA }) ?? {};
  } catch (e) {
    logWarn('tlGate: the config on the target branch does not parse; leaving the gate off', {
      configPath, ref: targetSha, errMessage: String(e?.message ?? e).slice(0, 200),
    });
    return null;
  }
  return { config: parseGateConfig(parsed, configPath), configPath };
}

/**
 * Compare user ids across the shapes platforms report them in: Bitbucket wraps
 * account UUIDs in braces (`{…}`), Azure DevOps GUIDs vary in casing, and the
 * config side may use either form with padding.
 *
 * @param {unknown} id
 * @returns {string}
 */
function normalizeId(id) {
  return String(id ?? '').trim().replace(/^\{(.*)\}$/, '$1').trim().toLowerCase();
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Make a platform-reported display name safe to put in a bot-authored comment.
 *
 * `actorLabel` is attacker-controlled free text (on GitHub, the profile `name`)
 * and lands verbatim in the *denied* comment. The gate's memory is a marker
 * search over the bot's own comments, so a label carrying marker syntax would
 * let a non-lead's denied comment open the gate on the next push.
 *
 * So our markers go in every form the codec matches (delimiters, spacing and
 * casing are not part of what `hasKey` looks for), lines cannot be forged, and
 * anything that still parses as markdown or raw HTML costs the label: the id
 * beside it is the authoritative field.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {unknown} label
 * @returns {string} the safe label, or '' when it cannot be made safe
 */
function safeLabel(provider, label) {
  const raw = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // Delimiters off *first*: dropping them after the stem would let a name that
  // split the token (`ai-review`:v1:tl-on) be stitched back into what we missed.
  let out = raw.replace(/<!--|-->|`/g, '');
  out = stripMarkerTokens(provider, out);
  out = out.replace(/\s+/g, ' ').trim();
  return /[[\]<>]/.test(out) ? '' : out;
}

/**
 * Remove every run containing the codec's marker prefix (the part of a rendered
 * marker before its key). `renderSummaryMarker` is the codec's own serialiser,
 * so the prefix comes from configuration, not a hardcoded string. Repeats until
 * stable so removing one token can never splice neighbours into a new one.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {string} text
 * @returns {string}
 */
function stripMarkerTokens(provider, text) {
  const probe = String(provider.renderSummaryMarker('summary') ?? '')
    .replace(/<!--|-->|`/g, '')
    .trim();
  const cut = probe.lastIndexOf(':');
  const stem = cut > 0 ? probe.slice(0, cut) : '';
  if (!stem) return text;
  const re = new RegExp(`[\\w.:-]*${escapeRegExp(stem)}[\\w.:-]*`, 'gi');
  let out = text;
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(re, '');
  }
  return out;
}

/** Longest platform user id we will echo into a comment. */
const MAX_SAFE_ID_LENGTH = 128;

/**
 * Make a platform-reported user id safe to put in a bot-authored comment.
 *
 * `actorId` is not safe by construction: on the env-sourced providers
 * (Bitbucket, Azure DevOps, GitLab) the manual step's own pipeline file sets
 * the variable the provider reads. Real ids are `[\w{}:.-]`-shaped, so anything
 * else is dropped first, then marker tokens are stripped (that order, so a
 * dropped character can never splice a marker together). The allowlist alone is
 * not enough: the marker prefix is made of allowlisted characters.
 *
 * Display only; the lead check compares the raw id via `normalizeId`.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {unknown} id
 * @returns {string} the safe id, or '' when nothing safe is left
 */
function safeId(provider, id) {
  const raw = String(id ?? '').trim().replace(/[^\w{}:.-]/g, '').slice(0, MAX_SAFE_ID_LENGTH);
  return stripMarkerTokens(provider, raw);
}

/**
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {{ actorId: string, actorLabel: string|null }} presser
 * @returns {string}
 */
function describePresser(provider, presser) {
  if (!presser || !presser.actorId) return 'An unidentified user';
  const id = safeId(provider, presser.actorId);
  // An id with nothing safe left is reported as unidentified rather than echoed.
  if (!id) return 'An unidentified user';
  const label = safeLabel(provider, presser.actorLabel);
  return label
    ? `**${label}** (user id \`${id}\`)`
    : `user id \`${id}\``;
}

/**
 * Markdown with hard breaks (two trailing spaces) between adjacent content
 * lines: Bitbucket's renderer collapses a single newline (same rule as
 * `summary-port.js`).
 *
 * @param {string[]} lines
 * @returns {string}
 */
function renderLines(lines) {
  return lines
    .map((line, i) => (
      line !== '' && lines[i + 1] !== undefined && lines[i + 1] !== '' ? `${line}  ` : line
    ))
    .join('\n');
}

/**
 * Body of the bot's "AI on" note: who turned it on, and when. Written once per
 * PR, on the press that turns it on.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {{ actorId: string, actorLabel: string|null }} presser
 * @param {Date} at
 * @returns {string}
 */
function buildNoteBody(provider, presser, at) {
  return renderLines([
    '### AI code review: on',
    '',
    `${describePresser(provider, presser)} turned the AI review on for this pull request at ${at.toISOString()}.`,
    'Every push from here is reviewed as usual.',
    '',
    provider.renderSummaryMarker(GATE_KEY),
    provider.renderSummaryMarker(ON_KEY),
  ]);
}

/**
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {{ howToTurnOn: string }} decision
 * @returns {string}
 */
function buildWaitingBody(provider, decision) {
  return renderLines([
    '### AI code review: waiting for a team lead',
    '',
    '`review.tlGate.enabled` is on, so this run did no review. A push never turns the AI on — only a team lead can.',
    '',
    `**To turn it on:** ${decision.howToTurnOn}`,
    '',
    'The next push is then reviewed as usual.',
    '',
    provider.renderSummaryMarker(GATE_KEY),
  ]);
}

/**
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {GateDecision} decision
 * @returns {string}
 */
function buildDeniedBody(provider, decision) {
  return renderLines([
    '### AI code review: not turned on',
    '',
    decision.reason === 'unknown-pressor'
      ? 'The button was pressed, but the platform reported no user id for this run, so nobody could be checked against `review.tlGate.leads`. This run did no review.'
      : `${describePresser(provider, decision.presser)} pressed the button, but that user id is not in \`review.tlGate.leads\` on the target branch. This run did no review.`,
    '',
    `**A team lead can turn it on:** ${decision.howToTurnOn}`,
    '',
    provider.renderSummaryMarker(GATE_KEY),
  ]);
}

/**
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {GateDecision} decision
 * @returns {string}
 */
function bodyFor(provider, decision) {
  if (decision.writeNote) return buildNoteBody(provider, decision.presser, decision.at);
  if (decision.reason === 'waiting') return buildWaitingBody(provider, decision);
  return buildDeniedBody(provider, decision);
}

/**
 * Write the gate's comment: the "AI on" note on the press that turns it on, or
 * the waiting / denied explanation. All share the `tl-gate` slot's sticky
 * upsert, so the PR carries one gate comment that later runs update in place.
 *
 * @param {import('../providers/provider.types.js').IReviewProvider} provider
 * @param {GateDecision} decision
 * @returns {Promise<'created'|'updated'|null>} null when there is nothing to write
 */
async function publish(provider, decision) {
  if (decision.reason === 'switch-off' || decision.reason === 'note') return null;
  const body = bodyFor(provider, decision);
  const res = await provider.upsertSummaryComment(GATE_KEY, body);
  return res?.action ?? null;
}

/**
 * Decide whether this run may review. With the switch off (or unreadable) the
 * answer is `on: true, reason: 'switch-off'`: the gate is not engaged and the
 * caller runs exactly as before.
 *
 * @param {{
 *   provider: import('../providers/provider.types.js').IReviewProvider,
 *   cwd: string,
 *   cliFlags?: { configPath?: string },
 *   targetSha: string,
 *   now?: Date,
 * }} opts
 * @returns {Promise<GateDecision>}
 */
async function evaluate({ provider, cwd, cliFlags, targetSha, now = new Date() }) {
  const read = await readGateFromTargetBranch({ provider, cwd, cliFlags, targetSha });
  const configPath = read?.configPath ?? resolveConfigPath(cwd, cliFlags);
  if (!read || !read.config.enabled) {
    // Gate not engaged: run as before, no trigger lookup, nothing published.
    return {
      on: true,
      reason: 'switch-off',
      presser: null,
      howToTurnOn: '',
      configPath,
      writeNote: false,
      at: now,
    };
  }

  // Trigger facts are read only now: on GitHub, resolving the presser is an API call.
  const trigger = await provider.getTriggerInfo();
  /** @type {{ actorId: string, actorLabel: string|null }|null} */
  let presser = null;
  // A press with no id is refused below — but only after the note lookup, so an
  // unverifiable id cannot hold back a PR whose "AI on" note already opened it.
  let unknownPresser = false;
  const base = {
    presser: null,
    howToTurnOn: trigger.howToTurnOn,
    configPath,
    at: now,
  };
  const off = (/** @type {GateDecision['reason']} */ reason) => ({
    ...base, on: false, reason, presser, writeNote: false,
  });

  if (trigger.manual) {
    presser = { actorId: trigger.actorId ?? '', actorLabel: trigger.actorLabel ?? null };
    if (!presser.actorId) {
      unknownPresser = true;
      // Fail closed on the press and log it: only the operator can fix this
      // (Azure DevOps may land here; see the TODO in `azure-tl-gate.js`).
      logWarn('tlGate: the button was pressed but the platform reported no user id for this run; refusing the press', {
        configPath, howToTurnOn: trigger.howToTurnOn,
      });
    } else if (read.config.leads.some((lead) => normalizeId(lead) === normalizeId(presser.actorId))) {
      return { ...base, on: true, reason: 'lead-press', presser, writeNote: true };
    }
  }

  // Looked up by `ON_KEY`, not the slot key, or the bot's own "waiting" comment
  // would open the gate on the next push.
  const note = await provider.findBotComment(ON_KEY);
  // Only the bot's untouched note counts: it can be edited, or a human can paste the marker.
  if (note && !note.editedByOther) {
    return {
      ...base, on: true, reason: 'note', presser, writeNote: false,
    };
  }
  if (note?.editedByOther) {
    logWarn('tlGate: the "AI on" note was edited by someone else; ignoring it', { markerKey: GATE_KEY });
  }
  return off(unknownPresser ? 'unknown-pressor' : trigger.manual ? 'not-lead' : 'waiting');
}

module.exports = {
  GATE_KEY,
  ON_KEY,
  evaluate,
  publish,
  bodyFor,
  buildNoteBody,
  buildWaitingBody,
  buildDeniedBody,
  parseGateConfig,
  resolveConfigPath,
  normalizeId,
  __test__: { renderLines, describePresser, safeLabel, safeId, stripMarkerTokens },
};
