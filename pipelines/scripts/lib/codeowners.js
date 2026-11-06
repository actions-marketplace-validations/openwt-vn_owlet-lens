// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CODEOWNERS_PATHS = [
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
];

/**
 * Parse a CODEOWNERS file into ordered rules (last match wins, like Git).
 * Each rule is { pattern: string, owners: string[] }.
 *
 * @param {string} content
 * @returns {{ pattern: string, owners: string[] }[]}
 */
function parseCodeowners(content) {
  const rules = [];
  for (const line of content.split('\n')) {
    const stripped = line.replace(/#.*$/, '').trim();
    if (!stripped) continue;
    const parts = stripped.split(/\s+/);
    if (parts.length < 2) continue;
    rules.push({ pattern: parts[0], owners: parts.slice(1) });
  }
  return rules;
}

/**
 * Find the CODEOWNERS file in standard locations.
 * @param {string} repoRoot
 * @returns {{ path: string, rules: { pattern: string, owners: string[] }[] } | null}
 */
function loadCodeowners(repoRoot) {
  for (const rel of CODEOWNERS_PATHS) {
    const abs = path.join(repoRoot, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return { path: rel, rules: parseCodeowners(content) };
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        process.stderr.write(JSON.stringify({ level: 'warn', msg: 'codeowners read failed', path: rel, error: e?.message }) + '\n');
      }
    }
  }
  return null;
}

/**
 * Match a file path against a CODEOWNERS pattern. Simplified matching:
 * - `*.ext` matches any file with that extension
 * - `dir/` matches anything under that directory
 * - `dir/*` matches files directly in that directory
 * - `/path` matches from repo root
 * - `*` matches everything
 *
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
function escapeRegexMeta(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern) {
  let p = pattern;
  const rooted = p.startsWith('/');
  if (rooted) p = p.slice(1);
  if (p.endsWith('/')) p += '**';

  let re = '';
  for (let i = 0; i < p.length;) {
    if (p[i] === '*' && p[i + 1] === '*') {
      const before = p[i - 1], after = p[i + 2];
      if ((!before || before === '/') && (!after || after === '/')) {
        re += '.*';
        i += after === '/' ? 3 : 2;
      } else {
        re += '[^/]*';
        i += 2;
      }
    } else if (p[i] === '*') {
      re += '[^/]*';
      i++;
    } else if (p[i] === '?') {
      re += '[^/]';
      i++;
    } else {
      re += escapeRegexMeta(p[i]);
      i++;
    }
  }

  return rooted || p.includes('/')
    ? new RegExp('^' + re + '$')
    : new RegExp('(^|/)' + re + '$');
}

const regexCache = new Map();

function matchPattern(filePath, pattern) {
  const normalized = filePath.replace(/\\/g, '/');
  if (pattern === '*') return true;
  let re = regexCache.get(pattern);
  if (!re) { re = patternToRegex(pattern); regexCache.set(pattern, re); }
  return re.test(normalized);
}

/**
 * For a list of changed file paths, find the owners per CODEOWNERS rules
 * (last-match-wins). Returns a map of owner → files[].
 *
 * @param {string[]} filePaths
 * @param {{ pattern: string, owners: string[] }[]} rules
 * @returns {Map<string, string[]>}
 */
function findOwners(filePaths, rules) {
  const ownerFiles = new Map();
  for (const fp of filePaths) {
    let matched = [];
    for (const rule of rules) {
      try {
        if (matchPattern(fp, rule.pattern)) matched = rule.owners;
      } catch {
        process.stderr.write(JSON.stringify({ level: 'warn', msg: 'codeowners pattern failed', pattern: rule.pattern }) + '\n');
      }
    }
    for (const owner of matched) {
      if (!ownerFiles.has(owner)) ownerFiles.set(owner, []);
      ownerFiles.get(owner).push(fp);
    }
  }
  return ownerFiles;
}

module.exports = { parseCodeowners, loadCodeowners, matchPattern, findOwners };
