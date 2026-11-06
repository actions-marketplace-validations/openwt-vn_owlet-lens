// @ts-check
'use strict';

/**
 * Azure DevOps' half of the TL gate: reading the button press off the CI
 * environment, and finding the bot's own "AI on" note on the PR.
 *
 * Split out of `azure-devops.js` for the same reason as `github-threads.js` /
 * `bitbucket-threads.js`: those concerns are the platform's own (ADR-0012) and
 * the main adapter has no room left for them.
 *
 * The button is a second build-validation policy (Manual + Optional), whose
 * pipeline exports `AI_REVIEW_TL_PRESSED`. Azure has no PR-comment trigger ("only
 * for GitHub repositories") and no CI variable that marks a manually queued
 * build as manual in a way a push cannot imitate, so the pipeline declares
 * itself. Which build that is, and who queued it:
 *
 *   - `Build.Reason` is `Manual` for a build a user queued, but the gate keys off
 *     the pipeline's own variable instead: a `Manual` policy build queued by hand
 *     and one queued by a hook look the same in CI variables.
 *   - `Build.RequestedForId` / `Build.QueuedById` are the identity GUIDs. For a
 *     build queued by hand both are the person who clicked, which is the durable
 *     id `review.tlGate.leads` holds (GUID casing differs between Azure
 *     endpoints; the gate normalises).
 *
 * TODO(#108): the live test for this policy is still open — confirm which
 * identity row Azure reports for a policy build queued from the PR page, and
 * that it matches the comment author id. If it does not, the fallback is a TL
 * commenting `/ai-review on`, which needs a provider method that lists PR
 * comments with author ids (none exists yet).
 */

const { tlPressSet } = require('./provider.types.js');

/** @typedef {import('./azure-devops.js').AzureDevOpsReviewProvider} AzureProvider */

/**
 * @param {AzureProvider} p
 * @returns {Promise<import('./provider.types.js').TriggerInfo>}
 */
async function triggerInfo(p) {
  const manual = tlPressSet(p.env);
  return {
    manual,
    actorId: manual ? (p.env.BUILD_REQUESTEDFORID ?? p.env.BUILD_QUEUEDBYID ?? null) : null,
    actorLabel: manual ? (p.env.BUILD_REQUESTEDFOR ?? p.env.BUILD_QUEUEDBY ?? null) : null,
    howToTurnOn: 'On the PR\'s Policies page, queue the **AI code review — turn on (team lead)** policy build.',
  };
}

/**
 * The bot's own PR-level comment carrying `markerKey`, or null. Azure has no
 * PR-level comment API: the summary lives in a thread with no threadContext, so
 * the lookup mirrors `upsertSummaryComment`. `editedByOther` is always false —
 * the API does not report who edited a comment, so an accepted limit rather than
 * a claim that edits cannot happen.
 *
 * @param {AzureProvider} p
 * @param {string} markerKey
 * @returns {Promise<import('./provider.types.js').BotComment|null>}
 */
async function findBotComment(p, markerKey) {
  const prId = p._requirePr();
  await p._ensureSelfIdentity();
  const rawThreads = await p._api('GET', p._url(`/pullRequests/${prId}/threads`));
  for (const thread of rawThreads?.value ?? []) {
    if (thread.threadContext) continue;
    const root = (thread.comments ?? []).filter((c) => !c.isDeleted)[0];
    if (!root || !p.codec.hasKey(root.content ?? '', markerKey) || !p._isBotComment(root)) continue;
    return {
      id: String(root.id),
      body: root.content ?? '',
      createdAt: root.publishedDate ?? root.lastUpdatedDate ?? '',
      editedByOther: false,
    };
  }
  return null;
}

module.exports = { triggerInfo, findBotComment };
