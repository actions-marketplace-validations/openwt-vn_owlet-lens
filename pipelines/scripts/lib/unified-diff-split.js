// @ts-check
'use strict';

/** @typedef {import('./providers/provider.types.js').DiffFile} DiffFile */

/**
 * Split one combined unified diff (as returned by Bitbucket Cloud's
 * `GET /pullrequests/{id}/diff`) into per-file entries shaped like the
 * GitHub provider's listFiles output, so the rest of the pipeline
 * (diff-annotate, finding-validator) consumes it unchanged.
 *
 * @param {string} diffText
 * @returns {DiffFile[]}
 */
function splitUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim() === '') return [];

  const lines = diffText.split('\n');
  /** @type {string[][]} */
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
    // Lines before the first `diff --git` header (preamble) are ignored.
  }

  return blocks.map((block) => parseBlock(block)).filter((f) => f !== null);
}

/**
 * @param {string[]} block
 * @returns {DiffFile | null}
 */
function parseBlock(block) {
  const header = block[0];
  // `diff --git a/<old> b/<new>` — paths may contain spaces, but Bitbucket
  // quotes those; the common case is space-free. Capture greedily then trim
  // the a/ b/ prefixes from the +++/--- lines below for authority.
  let newPath = null;
  let oldPath = null;
  /** @type {'add'|'modify'|'delete'|'rename'} */
  let change = 'modify';
  let isRename = false;

  for (const line of block) {
    if (line.startsWith('new file mode')) change = 'add';
    else if (line.startsWith('deleted file mode')) change = 'delete';
    else if (line.startsWith('rename from ')) {
      isRename = true;
      oldPath = line.slice('rename from '.length).trim();
    } else if (line.startsWith('rename to ')) {
      isRename = true;
      newPath = line.slice('rename to '.length).trim();
    } else if (line.startsWith('--- ')) {
      const p = stripDiffPath(line.slice(4).trim());
      if (p !== null) oldPath = oldPath ?? p;
    } else if (line.startsWith('+++ ')) {
      const p = stripDiffPath(line.slice(4).trim());
      if (p !== null) newPath = newPath ?? p;
    }
  }

  if (isRename) change = 'rename';

  // Fall back to the `diff --git` header when +++/--- were /dev/null or absent.
  // Paths may be git-quoted ("a/my file.js") when they contain spaces/special
  // chars; tolerate optional surrounding quotes and strip them from captures.
  if (newPath === null || oldPath === null) {
    const m = header.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    if (m) {
      oldPath = oldPath ?? unquote(m[1]);
      newPath = newPath ?? unquote(m[2]);
    }
  }

  const path = change === 'delete' ? (oldPath ?? newPath) : (newPath ?? oldPath);
  if (!path) return null;

  // patch = everything from the first hunk header onward (what diff-annotate
  // expects). If there is no hunk (binary/mode-only), patch is empty string.
  const hunkStart = block.findIndex((l) => l.startsWith('@@'));
  const patch = hunkStart === -1 ? '' : block.slice(hunkStart).join('\n');

  /** @type {DiffFile} */
  const entry = { path, change, patch };
  if (change === 'rename' && oldPath && oldPath !== path) entry.oldPath = oldPath;
  return entry;
}

/**
 * Strip surrounding double quotes git adds around paths containing spaces or
 * special chars (e.g. `"a/my file.js"`). No-op when unquoted.
 * @param {string} s
 * @returns {string}
 */
function unquote(s) {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Turn a `--- a/foo` / `+++ b/foo` path token into a repo-relative path.
 * Returns null for `/dev/null`. Handles git-quoted paths (`"a/my file.js"`):
 * quotes wrap the whole token including the a//b/ prefix, so unquote first.
 * @param {string} token
 * @returns {string|null}
 */
function stripDiffPath(token) {
  const t = unquote(token);
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

module.exports = { splitUnifiedDiff };
