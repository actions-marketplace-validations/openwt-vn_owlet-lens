// @ts-check
'use strict';

const SNIPPET_RADIUS = 5;

/**
 * @param {Array<{ path: string, patch: string, oldPath?: string }>} diffFiles
 * @param {string} filePath
 * @returns {string}
 */
function sliceFileDiff(diffFiles, filePath) {
  if (!Array.isArray(diffFiles)) return '';
  for (const f of diffFiles) {
    if (f.path === filePath || f.oldPath === filePath) {
      return f.patch ?? '';
    }
  }
  return '';
}

/**
 * @param {string|null} fileContent
 * @param {number} line 1-indexed line number
 * @returns {string}
 */
function sliceSnippet(fileContent, line) {
  if (fileContent == null) return '';
  const lines = fileContent.split('\n');
  const start = Math.max(0, line - 1 - SNIPPET_RADIUS);
  const end = Math.min(lines.length, line + SNIPPET_RADIUS);
  const out = [];
  for (let i = start; i < end; i++) {
    out.push(`${String(i + 1).padStart(4)} | ${lines[i]}`);
  }
  return out.join('\n');
}

/**
 * @param {Array<{ isBot: boolean, body?: string, author?: string, authorEmail?: string }>} comments
 * @returns {string}
 */
function buildThreadTranscript(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return '';
  return comments.map((c, i) => {
    const identity = c.author ?? c.authorEmail;
    const who = c.isBot ? 'AI' : (identity ? `dev (${identity})` : 'dev');
    const tag = i === 0 ? ' [original finding]' : '';
    return `--- ${who}${tag} ---\n${c.body ?? ''}`;
  }).join('\n\n');
}

/**
 * Assemble rich per-thread context. Soft-fails: errors during the file-content
 * fetch are captured into `warnings` rather than thrown. `diffSlice` and
 * `fullThread` are pure string ops on inputs the caller already has and cannot
 * fail at this layer.
 *
 * @param {{
 *   provider: { getFileContent: (path: string, ref: string) => Promise<string|null> },
 *   thread: { id: string, filePath: string, line: number, comments: Array<{ isBot: boolean, body?: string, author?: string }> },
 *   prDiff: Array<{ path: string, patch: string, oldPath?: string }>,
 *   headSha: string,
 *   fileCache?: Map<string, Promise<string|null>>,
 * }} ctx
 * @returns {Promise<{ fullThread: string, codeSnippet: string, diffSlice: string, warnings: string[] }>}
 */
async function assembleReplyContext(ctx) {
  const { provider, thread, prDiff, headSha, fileCache } = ctx;
  const warnings = [];

  const fullThread = buildThreadTranscript(thread.comments);
  const diffSlice = sliceFileDiff(prDiff, thread.filePath);

  let codeSnippet = '';
  if (headSha) {
    const key = `${thread.filePath}@${headSha}`;
    let p = fileCache ? fileCache.get(key) : undefined;
    if (!p) {
      const fresh = provider.getFileContent(thread.filePath, headSha);
      // Evict rejected entries so later threads on the same file retry
      // instead of inheriting a poisoned cache entry.
      if (fileCache) {
        fileCache.set(key, fresh);
        fresh.catch(() => { if (fileCache.get(key) === fresh) fileCache.delete(key); });
      }
      p = fresh;
    }
    try {
      const content = await p;
      codeSnippet = sliceSnippet(content, thread.line);
      if (content == null) warnings.push(`file not found at HEAD: ${thread.filePath}`);
    } catch (e) {
      warnings.push(`getFileContent failed: ${e?.message ?? String(e)}`);
    }
  } else {
    warnings.push('headSha unavailable; skipped code snippet fetch');
  }

  return { fullThread, codeSnippet, diffSlice, warnings };
}

module.exports = {
  assembleReplyContext,
  __test__: { sliceFileDiff, sliceSnippet, buildThreadTranscript, SNIPPET_RADIUS },
};
