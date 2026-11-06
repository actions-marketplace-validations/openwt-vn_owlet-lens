// @ts-check
'use strict';

const { CONFIG } = require('./config.js');

/**
 * Build the Markdown body for a review finding comment.
 * Appends a GitHub suggestion block when the suggestion is valid
 * and the provider is GitHub.
 *
 * @param {{ filePath?: string, severity?: string, category?: string, body: string, suggestion?: string | null }} f
 * @param {string} providerName
 * @returns {string}
 */
function formatBody(f, providerName) {
  let body = `${CONFIG.aiReviewPrefix} **[${f.severity ?? 'UNKNOWN'}/${f.category ?? 'unknown'}]** ${f.body}`;
  const s = typeof f.suggestion === 'string' ? f.suggestion.trim() : '';
  if (s) {
    if (!s.includes('\n') && !s.includes('```') && providerName === 'github') {
      body += `\n\n\`\`\`suggestion\n${s}\n\`\`\``;
    } else {
      process.stderr.write(JSON.stringify({ level: 'debug', msg: 'suggestion.dropped', file: f.filePath, provider: providerName }) + '\n');
    }
  }
  return body;
}

module.exports = { formatBody };
