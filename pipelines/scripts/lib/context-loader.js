// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Minimatch } = require('minimatch');
const { safeMsg } = require('./log-safe.js');

function loadCodingStandards(cwd, configuredPath) {
  if (typeof configuredPath !== 'string') return '';
  const trimmed = configuredPath.trim();
  if (trimmed === '') return '';
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    process.stderr.write(JSON.stringify({
      level: 'warn',
      msg: 'codingStandardsPath unreadable; falling back to default prompt guidance',
      pathConfigured: trimmed,
      errMessage: safeMsg(e),
    }) + '\n');
    return '';
  }
}

function loadContextPaths(cwd, configuredPaths) {
  if (!Array.isArray(configuredPaths) || configuredPaths.length === 0) return '';
  const sections = [];
  for (const p of configuredPaths) {
    if (typeof p !== 'string') continue;
    const trimmed = p.trim();
    if (trimmed === '') continue;
    const abs = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      sections.push(`=== ${trimmed} ===\n${content}`);
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'contextPath unreadable; skipping',
        pathConfigured: trimmed,
        errMessage: safeMsg(e),
      }) + '\n');
    }
  }
  return sections.join('\n\n');
}

/**
 * Load an array of glob-gated coding standards entries from disk.
 * Deduplicates by resolved absolute path (first occurrence wins).
 * Unreadable files are warned and skipped.
 *
 * @param {string} cwd
 * @param {Array<{ glob: string, path: string }>|null|undefined} entries
 * @returns {Array<{ glob: string, content: string }>}
 */
function loadCodingStandardsArray(cwd, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const trimmed = entry.path.trim();
    const abs = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
    const resolved = path.resolve(abs);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      out.push({ glob: entry.glob, content });
    } catch (e) {
      process.stderr.write(JSON.stringify({
        level: 'warn',
        msg: 'codingStandards entry unreadable; skipping',
        glob: entry.glob,
        pathConfigured: trimmed,
        errMessage: safeMsg(e),
      }) + '\n');
    }
  }
  return out;
}

/**
 * Match loaded standards entries against a list of file paths.
 * Returns the concatenated content of all entries whose glob matches
 * at least one file. Uses all-match union semantics with array order.
 *
 * @param {Array<{ glob: string, content: string }>} loaded
 * @param {string[]} filePaths
 * @returns {string}
 */
function matchStandardsForFiles(loaded, filePaths) {
  if (loaded.length === 0 || filePaths.length === 0) return '';
  const matched = [];
  for (const entry of loaded) {
    const mm = new Minimatch(entry.glob, { matchBase: true, dot: true });
    for (const fp of filePaths) {
      if (mm.match(fp)) {
        matched.push(entry.content);
        break;
      }
    }
  }
  return matched.join('\n\n');
}

module.exports = { loadCodingStandards, loadContextPaths, loadCodingStandardsArray, matchStandardsForFiles };
