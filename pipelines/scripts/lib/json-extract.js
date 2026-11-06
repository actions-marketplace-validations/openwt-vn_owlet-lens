// @ts-check
'use strict';

// One balanced-brace JSON scanner for every LLM-response parser in the repo
// (review findings, reply verdicts, learn clusters, reflection verdicts). LLM
// text may wrap the object in markdown fences, prose, or trailing garbage; a
// greedy `{[\s\S]*}` regex fails on all three and can span two unrelated
// objects. This scanner walks brace depth from each `{` and is string-aware, so
// braces (and fences) inside string values don't confuse it.

/**
 * Return the first JSON object in `text` that satisfies `accept`. Scans every
 * balanced `{...}` candidate in order, skipping malformed candidates and
 * candidates the predicate rejects, so a stray object ahead of the real payload
 * does not hide it.
 *
 * @param {string} text
 * @param {(value: any) => boolean} [accept] Accept a parsed candidate; defaults
 *   to accepting the first candidate that parses.
 * @returns {any | null} First accepted object, or null when none parses.
 */
function extractJson(text, accept) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const wants = typeof accept === 'function' ? accept : null;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          let parsed;
          try {
            parsed = JSON.parse(text.slice(i, j + 1));
          } catch {
            // Not valid JSON — resume scanning at the next `{`.
            break;
          }
          if (!wants || wants(parsed)) return parsed;
          break; // Predicate rejected — resume scanning at the next `{`.
        }
      }
    }
    i = j; // The loop's `i++` resumes just past this candidate.
  }
  return null;
}

module.exports = { extractJson };
