// @ts-check
'use strict';

const { redactDiffSecrets } = require('./diff-secret-redact.js');

const MAX_DESCRIPTION_CHARS = 2000;
const TRUNCATED_NOTE = '\n[truncated]';

/**
 * Turn the author's raw PR description into prompt-safe context: template
 * comments dropped, secrets redacted, the delimiter tag removed so the text
 * cannot close its own block, and the length capped.
 *
 * @param {string|null|undefined} raw
 * @returns {{ text: string, redacted: number, truncated: boolean }}
 */
function preparePrDescription(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { text: '', redacted: 0, truncated: false };

  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<\/?\s*pr_description\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const { redacted: text, count } = redactDiffSecrets(cleaned);

  if (text.length <= MAX_DESCRIPTION_CHARS) return { text, redacted: count, truncated: false };
  return { text: text.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATED_NOTE, redacted: count, truncated: true };
}

module.exports = { preparePrDescription, MAX_DESCRIPTION_CHARS };
