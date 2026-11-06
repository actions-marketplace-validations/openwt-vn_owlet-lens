// @ts-check
'use strict';

const { safeMsg } = require('../log-safe.js');
const { logInfo, logWarn } = require('../log-helpers.js');

const CATEGORY_RE = /\*\*\[[A-Z]+\/([a-z]+)\]\*\*/;

/** @param {string} findingBody @returns {string|null} */
function parseCategory(findingBody) {
  const m = CATEGORY_RE.exec(String(findingBody ?? ''));
  return m ? m[1] : null;
}

/**
 * Read-only harvest of wontfix signals across recently merged PRs.
 * Keeps every category, including security; drops non-bot threads.
 *
 * @param {{ listMergedPRs: Function, listThreadsForPR: Function }} provider
 * @param {{ sinceISO: string, limit: number }} opts
 * @returns {Promise<Array<{ fingerprint: string, category: string, findingBody: string, devReply: string, author: string, prId: string, prUrl: string }>>}
 */
async function harvestWontfix(provider, { sinceISO, limit }) {
  const prs = await provider.listMergedPRs({ sinceISO, limit });
  // listMergedPRs is capped at `limit` (maxPrs); hitting it means older PRs in
  // the lookback window were not scanned, so a thin/under-counted result is
  // explained by truncation rather than genuinely-few signals.
  if (prs.length >= limit) {
    logWarn('learn.harvest.truncated', { cap: limit, sinceISO });
  }
  const items = [];
  // Counters surface where wontfix candidates drop off, so a thin result is
  // explainable (few merged PRs vs no AI threads vs no wontfix).
  const stats = {
    prsScanned: prs.length,
    prsSkipped: 0,        // listThreadsForPR threw
    aiThreads: 0,         // bot-authored, fingerprinted threads
    wontfixThreads: 0,    // of those, status=wontfix
  };
  for (const pr of prs) {
    let threads;
    try {
      threads = await provider.listThreadsForPR(pr.id);
    } catch (e) {
      stats.prsSkipped += 1;
      logWarn('learn.harvest.pr-skipped', { prId: pr.id, errMessage: safeMsg(e) });
      continue;
    }
    let prAi = 0;
    let prWontfix = 0;
    for (const t of threads) {
      const first = t.comments?.[0];
      const fingerprint = t.marker?.fingerprint ?? null;
      const isAi = !!(first && first.isBot && fingerprint);
      if (isAi) { stats.aiThreads += 1; prAi += 1; }
      if (t.status !== 'wontfix') continue;
      if (!isAi) continue;
      stats.wontfixThreads += 1; prWontfix += 1;
      const category = parseCategory(first.body);
      if (!category) continue;
      let devReplyComment = null;
      for (let i = t.comments.length - 1; i >= 0; i--) {
        if (!t.comments[i].isBot) { devReplyComment = t.comments[i]; break; }
      }
      items.push({
        fingerprint,
        category,
        findingBody: first.body,
        devReply: devReplyComment ? devReplyComment.body : '',
        author: devReplyComment ? devReplyComment.authorEmail : '',
        prId: pr.id,
        prUrl: pr.url,
      });
    }
    if (prAi > 0 || prWontfix > 0) {
      logInfo('learn.harvest.pr', { prId: pr.id, aiThreads: prAi, wontfixThreads: prWontfix });
    }
  }
  logInfo('learn.harvest.summary', { ...stats, harvestedItems: items.length, sinceISO, maxPrs: limit });
  return items;
}

module.exports = { harvestWontfix, parseCategory };
