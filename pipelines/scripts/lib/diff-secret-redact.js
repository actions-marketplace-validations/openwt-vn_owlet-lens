// @ts-check
'use strict';

const PATTERNS = [
  // API keys by prefix — more-specific prefixes first
  { re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { re: /(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{20,}/g },
  { re: /AIza[0-9A-Za-z_\-]{20,}/g },
  { re: /ghp_[A-Za-z0-9]{36,}/g },
  { re: /ghs_[A-Za-z0-9]{36,}/g },
  { re: /gho_[A-Za-z0-9]{36,}/g },
  { re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { re: /glpat-[A-Za-z0-9_\-]{20,}/g },
  { re: /AKIA[0-9A-Z]{16}/g },
  { re: /xox[bpsa]-[A-Za-z0-9\-]{20,}/g },

  // Generic assignment: key = "literal value" or key: 'literal value'
  // Handles quoted keys ("password": "val"), unquoted (password: "val"), and camelCase variants
  { re: /(["']?(?:password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token)["']?\s*[:=]\s*)(['"])(.+?)\2/gi, replace: 'assignment-quoted' },
  // Unquoted values: only match 16+ chars, and skip a value that is a plain
  // dotted member chain of letter-only identifiers (e.g. `opts.charsPerToken`),
  // which is a code reference, not a secret. Matching stays broad otherwise, so
  // unquoted camelCase keys (`clientSecret:`, `sessionToken=`, `myApiKey=`) are
  // still redacted. `\b` plus the letter-only segments keep real token shapes
  // (mixed case + digits, JWTs) from looking like a member chain.
  { re: /(["']?(?:password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token)["']?\s*[:=]\s*)(?![A-Za-z_][A-Za-z_]*\.[A-Za-z_][A-Za-z_]*\b)([A-Za-z0-9_\-./+]{16,})/gi, replace: 'assignment-unquoted' },

  // Bearer tokens in string literals
  { re: /(Bearer\s+)[A-Za-z0-9._\-]{20,}/gi, replace: 'bearer' },

  // Connection strings with embedded credentials (min 4 chars for password)
  { re: /(:\/\/[^:@\s]+:)([^@\s]{4,})(@)/g, replace: 'connection' },

  // PEM private key blocks. The regex here is only a label: `redactPemBlocks`
  // does its own delimiter scan (it must, to handle inline and multi-line
  // blocks and to preserve diff markers), so this pattern is never matched.
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replace: 'pem-start' },
];

/**
 * Scan a diff patch string for secret-shaped content and replace matches
 * with [REDACTED]. Returns the redacted string and a count of redactions.
 *
 * @param {string} text
 * @returns {{ redacted: string, count: number }}
 */
function redactDiffSecrets(text) {
  if (!text || typeof text !== 'string') return { redacted: '', count: 0 };

  let count = 0;
  let result = text;

  for (const { re, replace } of PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);

    if (replace === 'pem-start') {
      result = redactPemBlocks(result, (n) => { count += n; });
      continue;
    }

    result = result.replace(pattern, (match, ...args) => {
      count++;
      if (replace === 'assignment-quoted') {
        return `${args[0]}${args[1]}[REDACTED]${args[1]}`;
      }
      if (replace === 'assignment-unquoted' || replace === 'bearer') {
        return `${args[0]}[REDACTED]`;
      }
      if (replace === 'connection') {
        return `${args[0]}[REDACTED]${args[2]}`;
      }
      return '[REDACTED]';
    });
  }

  return { redacted: result, count };
}

// PEM delimiter sources. Kept as source strings, not as live RegExps: the
// scanner drives them with `g` + `lastIndex`, and a shared `g` RegExp carries
// mutable lastIndex state across calls, so a module-level instance would be a
// bug rather than an optimization. `new RegExp(src, 'g')` per call is cheap.
const PEM_BEGIN_SRC = '-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----';
const PEM_END_SRC = '-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----';

/** A redacted line keeps its diff marker and indentation, nothing else. */
const PEM_PAD_RE = /^[+\- ]?\s*/;

/**
 * Locate every non-overlapping span of PEM key material. A span runs from a
 * BEGIN delimiter to the next END delimiter, or to the end of the text when
 * the block is truncated. Scanning resumes after each span, so several blocks
 * are all found - including two on the same line, which a stateful line walk
 * misses.
 *
 * @param {string} text
 * @returns {{ beginStart: number, endStart: number, materialEnd: number }[]}
 */
function findPemSpans(text) {
  const begin = new RegExp(PEM_BEGIN_SRC, 'g');
  const end = new RegExp(PEM_END_SRC, 'g');
  const spans = [];
  let cursor = 0;

  for (;;) {
    begin.lastIndex = cursor;
    const b = begin.exec(text);
    if (!b) break;

    end.lastIndex = b.index + b[0].length;
    const e = end.exec(text);
    spans.push({
      beginStart: b.index,
      endStart: e ? e.index : -1,
      materialEnd: e ? e.index + e[0].length : text.length,
    });
    cursor = spans[spans.length - 1].materialEnd;
  }

  return spans;
}

/**
 * Render one span as redaction tokens, one per source line, so the line count
 * and the diff shape survive.
 *
 * Only the material strictly between the delimiters is destroyed. Text before
 * the BEGIN on its line and after the END on its line is provably outside the
 * block and is kept - that is what preserves `const k = \`` and the trailing
 * `";` around an inline block. Everything else on a touched line becomes a
 * token, so a line carrying key material never leaks part of itself.
 *
 * Text after the END is NOT emitted here: the caller emits every raw segment
 * between spans, which covers it - and emitting it here too would duplicate it
 * (and leak a second block) when two blocks share a line.
 *
 * @param {string} text
 * @param {{ beginStart: number, endStart: number, materialEnd: number }} span
 */
function renderPemSpan(text, span) {
  const { beginStart, endStart, materialEnd } = span;
  const truncated = endStart === -1;
  const firstNl = text.indexOf('\n', beginStart);
  const spansLines = firstNl !== -1 && (truncated || firstNl < endStart);

  if (!spansLines) {
    return truncated ? '[REDACTED-PEM-BEGIN]' : '[REDACTED-PEM]';
  }

  const parts = ['[REDACTED-PEM-BEGIN]'];
  let lineStart = firstNl + 1;

  while (lineStart < materialEnd) {
    const nl = text.indexOf('\n', lineStart);
    const lineStop = nl === -1 ? text.length : nl;
    const isEndLine = !truncated && endStart >= lineStart && endStart < lineStop;
    // Pad comes from the text before the delimiter, never from the delimiter
    // itself - `-----END` at column 0 has an empty pad, not `-`.
    const pad = PEM_PAD_RE.exec(text.slice(lineStart, isEndLine ? endStart : lineStop))[0];

    if (isEndLine) {
      parts.push(`${pad}[REDACTED-PEM-END]`);
      break;
    }
    parts.push(`${pad}[REDACTED]`);
    if (lineStop >= materialEnd) break;
    lineStart = lineStop + 1;
  }

  // A truncated block can end exactly on a newline. The line after it is empty
  // but still a line, so keep the line count honest. A closed block always ends
  // on the END delimiter, never on a newline, so this only fires for truncation.
  if (text[materialEnd - 1] === '\n') parts.push('');

  return parts.join('\n');
}

/**
 * Redact PEM private key blocks, preserving line count and each line's diff
 * marker. Handles truncated blocks (no END marker).
 *
 * Works on spans rather than on line state. The invariant is positional and
 * easy to check: a span runs BEGIN..END, everything inside it is replaced,
 * everything outside it is untouched. That covers both shapes without special
 * cases - line-oriented blocks (a diff patch, a multi-line template literal)
 * and inline blocks whose whole body sits on one line, escaped as `\n` or not
 * (JSON/YAML config, env files, test fixtures) - and it makes several blocks
 * per line safe by construction.
 *
 * @param {string} text
 * @param {(n: number) => void} onRedact
 */
function redactPemBlocks(text, onRedact) {
  const spans = findPemSpans(text);
  onRedact(spans.length);
  if (spans.length === 0) return text;

  const out = [];
  let cursor = 0;
  for (const span of spans) {
    out.push(text.slice(cursor, span.beginStart));
    out.push(renderPemSpan(text, span));
    cursor = span.materialEnd;
  }
  out.push(text.slice(cursor));
  return out.join('');
}

/**
 * Apply secret redaction to each diff entry's patch field. Returns new
 * diff objects (never mutates input). Total redaction count is summed.
 *
 * @template {{ path: string, patch?: string }} T
 * @param {T[]} diffs
 * @returns {{ diffs: T[], totalRedacted: number }}
 */
function redactDiffs(diffs) {
  let totalRedacted = 0;
  const out = diffs.map((d) => {
    if (!d.patch) return { ...d };
    const { redacted, count } = redactDiffSecrets(d.patch);
    totalRedacted += count;
    return { ...d, patch: redacted };
  });
  return { diffs: out, totalRedacted };
}

module.exports = { redactDiffSecrets, redactDiffs };
