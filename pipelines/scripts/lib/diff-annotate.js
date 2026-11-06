// @ts-check
'use strict';

/**
 * Convert a unified-diff patch into a line-numbered annotated form for the
 * Claude prompt. Each output line is `<line>:<+|-| ><source>` so the model
 * can cite the line number directly.
 *
 * @param {string} diffText
 * @returns {string}
 */
function annotateDiff(diffText) {
  if (!diffText) return '';
  const lines = diffText.split('\n');
  const annotated = [];
  let newLineNum = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('-')) {
      annotated.push(`${newLineNum}:-${line.slice(1)}`);
    } else if (line.startsWith('+')) {
      annotated.push(`${newLineNum}:+${line.slice(1)}`);
      newLineNum++;
    } else if (newLineNum > 0) {
      annotated.push(`${newLineNum}: ${line.startsWith(' ') ? line.slice(1) : line}`);
      newLineNum++;
    }
  }
  return annotated.join('\n');
}

module.exports = { annotateDiff };
