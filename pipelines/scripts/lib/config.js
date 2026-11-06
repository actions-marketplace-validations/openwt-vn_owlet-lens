// @ts-check
'use strict';

const CONFIG = Object.freeze({
  reviewMaxTokens: 128_000,
  replyMaxTokensPerThread: 500,
  tokenBudget: 512_000,
  // Cap for the "already-found findings" summary injected into each chunk
  // prompt after the first. Bounded so prior findings can never crowd the
  // chunk's own diff out of the token budget.
  chunkFindingsSummaryTokens: 1_500,
  charsPerToken: 4,
  aiReviewPrefix: '[Owlet Lens]',
});

const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

/**
 * @param {string|null|undefined} sev
 * @returns {number} 1..4 for known severity, 0 otherwise
 */
function rankSeverity(sev) {
  if (!sev || typeof sev !== 'string') return 0;
  return SEVERITY_RANK[sev.toLowerCase()] ?? 0;
}

module.exports = { CONFIG, SEVERITY_RANK, rankSeverity };
