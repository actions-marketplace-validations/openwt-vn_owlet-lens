// @ts-check
'use strict';

// Strip HTML-comment and inline-code marker blocks so boilerplate marker
// tokens (`ai`, `review`, `v1`, `active`, ...) don't inflate similarity
// between unrelated findings that merely share our marker wire format.
const MARKER_RE = /<!--[\s\S]*?-->|`ai-review:[^`]*`/g;
const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'would', 'could', 'should',
  'when', 'where', 'which', 'while', 'than', 'then', 'them', 'they', 'their',
  'here', 'there', 'into', 'over', 'each', 'more', 'most', 'some', 'such',
  'only', 'also', 'even', 'does', 'doesn', 'been', 'being', 'because',
]);

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function significantTokens(text) {
  const stripped = String(text ?? '').replace(MARKER_RE, '');
  const words = stripped
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Jaccard similarity over significant (length > 3, non-stopword) tokens.
 * Used to recognize the same underlying finding reworded/re-graded across
 * review runs, independent of exact line or category:severity identity.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function textSimilarity(a, b) {
  const setA = significantTokens(a);
  const setB = significantTokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

module.exports = { textSimilarity };
