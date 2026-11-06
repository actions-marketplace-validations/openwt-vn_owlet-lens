// @ts-check
'use strict';

// Body prefix written by ai-review.js#formatBody at post time.
const SEV_CAT_RE = /\*\*\[([A-Z]+)\/([a-zA-Z]+)\]\*\*\s*(.*)/s;

/**
 * Build the [DISMISSED CONTEXT] prompt block from prior bot-authored
 * wontfix/fixed threads. Used as a Claude prompt addendum so re-detection
 * of dismissed findings is suppressed.
 *
 * Eligibility filter (all required):
 *   - status in {'wontfix', 'fixed'}
 *   - first comment is bot-authored
 *   - marker.version is truthy (proves bot wrote the marker; prevents
 *     human-fingerprint-collision threads from polluting the prompt)
 *
 * @param {Array<{
 *   id: string,
 *   status: string,
 *   filePath: string,
 *   line: number,
 *   comments: Array<{ isBot: boolean, body: string }>,
 *   marker?: { version?: string|null, fingerprint?: string|null },
 * }>} threads
 * @param {string} _markerPrefix  reserved; thread.marker is already parsed
 * @returns {{ prompt: string, dismissedCount: number }}
 */
function buildDismissedContext(threads, _markerPrefix) {
  const eligible = threads.filter(
    (t) =>
      (t.status === 'wontfix' || t.status === 'fixed') &&
      t.comments.length > 0 &&
      t.comments[0].isBot &&
      t.marker?.version,
  );

  if (eligible.length === 0) {
    return { prompt: '', dismissedCount: 0 };
  }

  const lines = ['[DISMISSED CONTEXT]'];
  lines.push(
    'Findings already triaged on this PR — do NOT re-flag the same issue at the same location:',
  );
  for (const t of eligible) {
    const m = SEV_CAT_RE.exec(t.comments[0].body ?? '');
    const sev = m?.[1] ?? 'UNKNOWN';
    const cat = m?.[2] ?? 'unknown';
    const summary = (m?.[3] ?? '').slice(0, 200).split('\n')[0];
    lines.push(`- ${t.filePath}:${t.line} [${sev}/${cat}] (${t.status}) ${summary}`);
  }
  return { prompt: lines.join('\n'), dismissedCount: eligible.length };
}

module.exports = { buildDismissedContext };
