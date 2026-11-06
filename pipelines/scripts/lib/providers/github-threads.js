// @ts-check
'use strict';

const markers = require('../markers.js');
const { safeMsg } = require('../log-safe.js');

// Read side of the GitHub adapter: review comments over REST, joined with the
// GraphQL thread map (thread id + resolved state) into ReviewThreads. Each
// function takes the provider instance `p` (its clients, owner/repo and the
// thread-map cache); github.js keeps one-line delegators, so the adapter's
// interface is unchanged.

/** @typedef {import('./github.js').GitHubReviewProvider} GitHubProvider */

function isBotComment(comment) {
  if (comment?.user?.type === 'Bot') return true;
  return /\[bot\]$|ai-bot/i.test(comment?.user?.login ?? '');
}

/** @param {GitHubProvider} p */
async function fetchAllReviewComments(p, prNumber = p.prNumber) {
  return p._paginate(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
    p.rest.pulls.listReviewComments.bind(p.rest.pulls),
    { owner: p.owner, repo: p.repo, pull_number: prNumber },
  );
}

/**
 * Fetch additional comments for a single review thread when the outer
 * page was full (>50 comments). Uses node(id:) lookup against the thread
 * GraphQL id, paging by endCursor until hasNextPage = false.
 *
 * @param {GitHubProvider} p
 * @param {string} threadGqlId
 * @param {string|null} afterCursor
 * @returns {Promise<Array<{ databaseId: number }>>}
 */
async function fetchThreadCommentsAfter(p, threadGqlId, afterCursor) {
  const extra = [];
  let cursor = afterCursor;
  for (;;) {
    const res = await p.graphql(
      `query($id:ID!,$after:String) {
         node(id:$id) {
           ... on PullRequestReviewThread {
             comments(first:50, after:$after) {
               nodes { databaseId }
               pageInfo { hasNextPage endCursor }
             }
           }
         }
       }`,
      { id: threadGqlId, after: cursor },
    );
    const c = res?.node?.comments;
    if (!c) break;
    extra.push(...(c.nodes ?? []));
    if (!c.pageInfo?.hasNextPage) break;
    const next = c.pageInfo.endCursor;
    if (next === cursor) break;
    cursor = next;
  }
  return extra;
}

/** @param {GitHubProvider} p */
async function fetchThreadResolvedMap(p, prNumber = p.prNumber) {
  // Cache only the current-PR map; arbitrary-PR lookups (learn harvest) are
  // one-shot and must not clobber the cached single-PR reconcile map.
  const useCache = prNumber === p.prNumber;
  if (useCache && p._cachedThreadMap) return p._cachedThreadMap;
  const map = new Map();
  let cursor = null;
  for (;;) {
    const res = await p.graphql(
      `query($owner:String!,$repo:String!,$num:Int!,$after:String) {
         repository(owner:$owner, name:$repo) {
           pullRequest(number:$num) {
             reviewThreads(first:50, after:$after) {
               nodes {
                 id
                 isResolved
                 comments(first:50) {
                   nodes { databaseId }
                   pageInfo { hasNextPage endCursor }
                 }
               }
               pageInfo { hasNextPage endCursor }
             }
           }
         }
       }`,
      { owner: p.owner, repo: p.repo, num: prNumber, after: cursor },
    );
    const rt = res.repository.pullRequest.reviewThreads;
    for (const node of rt.nodes ?? []) {
      const commentNodes = node.comments?.nodes ?? [];
      for (const c of commentNodes) {
        map.set(c.databaseId, { threadGqlId: node.id, isResolved: node.isResolved });
      }
      // Inner-paginate when a thread has >50 comments. Without this, later
      // comment databaseIds would be orphaned from the REST→GraphQL join in
      // listThreads, which can flip the derived thread status.
      if (node.comments?.pageInfo?.hasNextPage) {
        try {
          const extra = await fetchThreadCommentsAfter(
            p,
            node.id,
            node.comments.pageInfo.endCursor ?? null,
          );
          for (const c of extra) {
            map.set(c.databaseId, { threadGqlId: node.id, isResolved: node.isResolved });
          }
        } catch (e) {
          process.stderr.write(JSON.stringify({
            level: 'warn',
            msg: 'thread.inner-pagination.failed',
            threadGqlId: node.id,
            errName: e?.name,
            errMessage: e?.message,
          }) + '\n');
        }
      }
    }
    if (!rt.pageInfo.hasNextPage) break;
    const next = rt.pageInfo.endCursor;
    if (next === cursor) break;
    cursor = next;
  }
  if (useCache) p._cachedThreadMap = map;
  return map;
}

/**
 * @param {GitHubProvider} p
 * @param {number} prNumber
 * @returns {Promise<import('./provider.types.js').ReviewThread[]>}
 */
async function buildThreads(p, prNumber) {
  const [comments, threadMap] = await Promise.all([
    fetchAllReviewComments(p, prNumber),
    p._fetchThreadResolvedMap(prNumber),
  ]);
  const grouped = new Map();
  const orphanedIds = [];
  for (const c of comments) {
    const m = threadMap.get(c.id);
    if (!m) {
      // Comment from REST not present in the GraphQL resolved-map. Causes:
      // (a) thread has >50 comments and our query truncates (warned in
      // _fetchThreadResolvedMap), or (b) comment is on a thread with no
      // bot-readable resolution state. Track for diagnostic logging.
      orphanedIds.push(c.id);
      continue;
    }
    let entry = grouped.get(m.threadGqlId);
    if (!entry) {
      entry = {
        threadGqlId: m.threadGqlId,
        isResolved: m.isResolved,
        root: c,
        comments: [],
      };
      grouped.set(m.threadGqlId, entry);
    }
    entry.comments.push(c);
  }

  if (orphanedIds.length > 0) {
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        msg: 'review comments not in GraphQL resolved-map; dropped from listThreads result',
        // Cap the dump at 20 IDs so a pathological PR doesn't flood stderr.
        orphanedCommentIds: orphanedIds.slice(0, 20),
        totalOrphaned: orphanedIds.length,
      }) + '\n',
    );
  }

  return [...grouped.values()].map((e) => {
    // Use Number.isNaN so genuine epoch (timestamp 0) is distinguished
    // from malformed dates. NaN → 0 keeps insertion order; epoch sorts as
    // the earliest valid date.
    const tsOf = (s) => {
      const t = new Date(s).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const sortedComments = e.comments
      .slice()
      .sort((a, b) => {
        // Primary: created_at timestamp. Secondary: REST databaseId
        // (monotonically increasing) so same-second comments have a
        // stable, total order.
        const tDiff = tsOf(a.created_at) - tsOf(b.created_at);
        return tDiff !== 0 ? tDiff : (a.id ?? 0) - (b.id ?? 0);
      });

    // 'html' — GitHub markers are HTML comments only; parsing the inline-code
    // form here would let a human-typed `ai-review:...` backtick be read as a
    // real bot marker (status spoof / fingerprint injection).
    const rootParsed = markers.parseMarkers(e.root.body, p.markerPrefix, 'html');
    let latestStatus = rootParsed.status;
    let latestVersion = rootParsed.version;
    for (let i = sortedComments.length - 1; i >= 0; i--) {
      const c = sortedComments[i];
      if (!isBotComment(c)) continue;
      const parsed = markers.parseMarkers(c.body, p.markerPrefix, 'html');
      if (parsed.status) {
        latestStatus = parsed.status;
        // version travels with the latest bot status marker so reconcilePort's
        // `marker.version` truthy check still applies even when the root
        // comment lacks a version marker (e.g., human-rooted thread the bot
        // later replied into).
        if (parsed.version) latestVersion = parsed.version;
        break;
      }
    }
    const status = latestStatus ?? (e.isResolved ? 'resolved' : 'active');

    return {
      id: e.threadGqlId,
      status,
      // The GraphQL flag, kept alongside the merged status so a later run can
      // tell "the marker says fixed" from "the UI still shows it open".
      platformResolved: e.isResolved === true,
      filePath: e.root.path,
      line: e.root.line ?? 0,
      comments: sortedComments.map((c) => ({
        id: String(c.id),
        authorEmail: c.user?.email ?? c.user?.login ?? '',
        body: c.body,
        createdAt: c.created_at,
        isBot: isBotComment(c),
      })),
      marker: { version: latestVersion, fingerprint: rootParsed.fingerprint },
    };
  });
}

/**
 * How a team lead turns the AI on from GitHub. There is no GitHub-specific
 * control to build: "Re-run all jobs" on the PR's AI review run *is* the button,
 * and the gate recognises it from `GITHUB_RUN_ATTEMPT`. Quoted verbatim in the
 * gate's comments, so a PR author does not have to guess.
 */
const HOW_TO_TURN_ON = 'On the PR, open the latest **Owlet Lens** run in the Actions tab and click **Re-run all jobs**.';

/**
 * Did a human press GitHub's "Re-run all jobs" button on this PR's review run,
 * and who pressed it?
 *
 * A re-run past the first attempt is the button. `GITHUB_EVENT_NAME` is checked
 * as well, because the same variable also counts attempts on `/review` comment
 * runs, and the `/review` comment must never be able to turn the AI on. A re-run
 * reuses the original event's SHA, so it reviews whatever the PR head is now —
 * which is exactly what the button should do.
 *
 * `GITHUB_TRIGGERING_ACTOR` is the re-run initiator's login ("If the workflow
 * run is a re-run, this value may differ from github.actor"), so the users API
 * turns it into the durable numeric id the TL list holds: "their login, which
 * can change over time", an id cannot.
 *
 * @param {GitHubProvider} p
 * @returns {Promise<import('./provider.types.js').TriggerInfo>}
 */
async function triggerInfo(p) {
  const attempt = Number(p.env.GITHUB_RUN_ATTEMPT ?? 1);
  const manual = p.env.GITHUB_EVENT_NAME === 'pull_request'
    && Number.isFinite(attempt) && attempt > 1;
  const login = p.env.GITHUB_TRIGGERING_ACTOR ?? null;
  if (!manual) return { manual: false, actorId: null, actorLabel: null, howToTurnOn: HOW_TO_TURN_ON };
  let actorId = null;
  let actorLabel = login;
  if (login) {
    try {
      const { data } = await p.rest.users.getByUsername({ username: login });
      actorId = data?.id == null ? null : String(data.id);
      actorLabel = data?.name ?? data?.login ?? login;
    } catch (e) {
      // Not fatal: a press whose id cannot be resolved is reported as an
      // unverified presser, which the gate treats as "not a team lead".
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'tlGate: could not resolve the re-run actor to a numeric user id',
        errName: e?.name,
        errMessage: safeMsg(e),
      }) + '\n');
    }
  }
  return { manual: true, actorId, actorLabel, howToTurnOn: HOW_TO_TURN_ON };
}

/**
 * The bot's own PR-conversation comment carrying `markerKey`, or null.
 *
 * Read over GraphQL rather than REST because the gate has to know whether a
 * human edited the note afterwards: "Anyone with write access to a repository
 * can edit comments on issues, discussions, pull requests, and commits", and
 * REST has no `editor` field. An edited note is returned with
 * `editedByOther: true` so the caller can refuse to treat it as the bot's own
 * record.
 *
 * @param {GitHubProvider} p
 * @param {string} markerKey
 * @returns {Promise<import('./provider.types.js').BotComment|null>}
 */
async function findBotComment(p, markerKey) {
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const res = await p.graphql(
      `query($owner:String!,$repo:String!,$num:Int!,$after:String) {
         repository(owner:$owner, name:$repo) {
           pullRequest(number:$num) {
             comments(first:100, after:$after) {
               nodes { databaseId body createdAt author { login } editor { login } }
               pageInfo { hasNextPage endCursor }
             }
           }
         }
       }`,
      { owner: p.owner, repo: p.repo, num: p.prNumber, after: cursor },
    );
    const conn = res?.repository?.pullRequest?.comments;
    if (!conn) break;
    const hit = (conn.nodes ?? []).find(
      (/** @type {any} */ c) => c && p.codec.hasKey(c.body ?? '', markerKey)
        && isBotComment({ user: c.author }),
    );
    if (hit) {
      return {
        id: String(hit.databaseId),
        body: hit.body ?? '',
        createdAt: hit.createdAt ?? '',
        editedByOther: !!hit.editor && hit.editor.login !== hit.author?.login,
      };
    }
    if (!conn.pageInfo?.hasNextPage) break;
    const next = conn.pageInfo.endCursor;
    if (next === cursor) break;
    cursor = next;
  }
  return null;
}

module.exports = {
  isBotComment, fetchThreadResolvedMap, buildThreads, triggerInfo, findBotComment,
};
