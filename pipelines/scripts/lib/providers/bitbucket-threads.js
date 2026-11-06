// @ts-check
'use strict';

const markers = require('../markers.js');

/**
 * Learn the bot's own account id from existing comments, so identity is
 * account-based rather than "any comment with a marker is ours".
 *
 * Bitbucket repository/workspace access tokens have no user account
 * (`GET /2.0/user` 401s), and the account id is otherwise only learned *after*
 * we post within a process — so the first `listThreads` (before any post) had
 * to fall back to marker presence, which let a human spoof bot identity by
 * writing a marker token. Instead, infer the bot account from the author of
 * comments that already carry our marker: the bot stamps a marker on every
 * comment it writes, so the account authoring marker-bearing comments IS the
 * bot. Pick the most frequent such author so a lone spoofed marker can't win
 * once any genuine bot comment exists.
 *
 * @param {any[]} comments
 * @param {string} markerPrefix
 * @returns {string|null} the inferred account id, or null when none carry a marker
 */
function inferSelfAccountId(comments, markerPrefix) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const c of comments) {
    const acc = c?.user?.account_id;
    if (acc && markers.hasMarker(c.content?.raw ?? '', markerPrefix)) {
      counts.set(acc, (counts.get(acc) ?? 0) + 1);
    }
  }
  let best = null;
  let bestN = 0;
  for (const [acc, n] of counts) {
    if (n > bestN) { best = acc; bestN = n; }
  }
  return best;
}

/**
 * Group flat Bitbucket comments into review threads keyed by their root
 * (parent) comment, deriving per-thread marker status and shape expected by
 * the reconcile/reply pipeline.
 *
 * @param {{ comments: any[], isSelf: (c: any) => boolean, markerPrefix: string }} args
 * @returns {any[]}
 */
function groupThreads({ comments, isSelf, markerPrefix }) {
  /** @type {Map<number, any[]>} */
  const byRoot = new Map();
  /** @type {Map<number, any>} */
  const roots = new Map();
  for (const c of comments) {
    const parentId = c.parent?.id ?? null;
    const rootId = parentId ?? c.id;
    if (parentId === null) roots.set(c.id, c);
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    const arr = byRoot.get(rootId);
    if (arr) arr.push(c);
  }

  /** @param {string} s */
  const tsOf = (s) => {
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  /** @type {any[]} */
  const threads = [];
  for (const [rootId, group] of byRoot.entries()) {
    // The thread root is the parent comment (parentId === null). If it was
    // deleted, fall back to the first comment in the group that still carries
    // inline position. Skip the group entirely when the root isn't an inline
    // comment — Bitbucket's /comments endpoint also returns GLOBAL comments
    // (e.g. our own summary, general PR comments), which are not review
    // threads. GitHub avoids this by listing only review comments; we filter
    // here. (Replies legitimately lack `inline`, so we filter on the root,
    // not on every comment, to keep the dev's replies in the thread.)
    const root = roots.get(rootId) ?? group.find((c) => c.inline);
    if (!root || !root.inline) continue;
    const sorted = group.slice().sort((a, b) => {
      const d = tsOf(a.created_on) - tsOf(b.created_on);
      return d !== 0 ? d : (a.id ?? 0) - (b.id ?? 0);
    });

    // Marker status: last bot comment carrying a status marker wins.
    const rootParsed = markers.parseMarkers(root.content?.raw ?? '', markerPrefix);
    let latestStatus = rootParsed.status;
    let latestVersion = rootParsed.version;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (!isSelf(sorted[i])) continue;
      const parsed = markers.parseMarkers(sorted[i].content?.raw ?? '', markerPrefix);
      if (parsed.status) {
        latestStatus = parsed.status;
        if (parsed.version) latestVersion = parsed.version;
        break;
      }
    }
    const resolved = root.resolution != null;
    const status = latestStatus ?? (resolved ? 'resolved' : 'active');

    threads.push({
      id: String(rootId),
      status,
      // `root.resolution` is Bitbucket's own resolve flag, kept alongside the
      // marker-derived status so a stuck thread is detectable on a later run.
      platformResolved: resolved,
      filePath: root.inline?.path ?? '',
      line: root.inline?.to ?? root.inline?.from ?? 0,
      comments: sorted.map((c) => ({
        id: String(c.id),
        authorEmail: c.user?.nickname ?? c.user?.account_id ?? '',
        body: c.content?.raw ?? '',
        createdAt: c.created_on ?? '',
        isBot: isSelf(c),
      })),
      marker: { version: latestVersion, fingerprint: rootParsed.fingerprint },
    });
  }
  return threads;
}

module.exports = { inferSelfAccountId, groupThreads };
