#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Parses Node's built-in test coverage TAP output and exits non-zero if
 * line coverage on `pipelines/scripts/lib/**` falls below THRESHOLD.
 *
 * Reads stdin (pipe `node --test --experimental-test-coverage` into it).
 */

const THRESHOLD = 80;

/**
 * Node's --experimental-test-coverage TAP output uses indented short filenames,
 * not full paths. The report looks like:
 *
 *   # pipelines                |        |          |         |
 *   #  scripts                 |        |          |         |
 *   #   lib                    |        |          |         |
 *   #    claude-api.js         |  93.75 |    86.21 |   83.33 | 114-121
 *   #    port                  |        |          |         |
 *   #     dismissal-port.js    | 100.00 |    94.74 |  100.00 |
 *
 * We reconstruct the full path by tracking the directory context as we
 * walk through the indented tree inside the coverage section.
 *
 * Strategy: map each leading-space indentation level to a path segment,
 * then when we see a file line (contains `|` and a numeric column) that
 * falls under `pipelines/scripts/lib`, record it.
 *
 * Before regex adjustment the original plan had:
 *   /^#\s+(pipelines\/scripts\/lib\/[^\s|]+)\s*\|\s*([\d.]+)\s*\|/
 * which assumed full paths — incompatible with the actual indented format.
 */

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buf += chunk; });
process.stdin.on('end', () => {
  const lines = buf.split('\n');
  /** @type {Array<{file: string, lineCov: number}>} */
  const perFile = [];
  let inCoverage = false;

  // Track path segments by indent level (number of leading spaces after "# ")
  // e.g. "# pipelines" → indent 0 → segments[0] = "pipelines"
  //      "#  scripts"  → indent 1 → segments[1] = "scripts"
  //      "#   lib"     → indent 2 → segments[2] = "lib"
  //      "#    port"   → indent 3 → segments[3] = "port"
  /** @type {string[]} */
  const segments = [];

  for (const l of lines) {
    if (l.includes('# start of coverage report')) { inCoverage = true; continue; }
    if (l.includes('# end of coverage report')) { inCoverage = false; continue; }
    if (!inCoverage) continue;

    // Coverage lines start with "# " then leading spaces then name
    // Skip separator lines (all dashes)
    if (/^#[-\s]+$/.test(l) || /^# -+/.test(l)) continue;

    // Match: "# " + spaces + name + optional "| ..."
    const lineMatch = /^# ( *)([\w.\-]+)\s*(\|(.*))?$/.exec(l);
    if (!lineMatch) continue;

    const indent = lineMatch[1].length;     // number of leading spaces
    const name = lineMatch[2];              // e.g. "claude-api.js" or "lib"
    const hasColumns = Boolean(lineMatch[3]); // has "|" — could be a file or dir row with data

    // Trim segments array to current indent level, then set this level's segment
    segments.length = indent;
    segments[indent] = name;

    // Only capture rows that have a numeric line-coverage column
    if (!hasColumns) continue;
    const colMatch = /\|\s*([\d.]+)\s*\|/.exec(lineMatch[3] || '');
    if (!colMatch) continue; // directory summary row with empty columns

    // Reconstruct full path from segments
    const fullPath = segments.join('/');
    if (!fullPath.includes('pipelines/scripts/lib')) continue;

    perFile.push({ file: fullPath, lineCov: Number(colMatch[1]) });
  }
  if (perFile.length === 0) {
    process.stderr.write(JSON.stringify({
      level: 'error',
      msg: 'coverage-gate: no per-file lib/ coverage rows parsed; check --experimental-test-coverage output format',
    }) + '\n');
    process.exit(2);
  }
  const below = perFile.filter((r) => r.lineCov < THRESHOLD);
  const overall = perFile.reduce((a, r) => a + r.lineCov, 0) / perFile.length;
  process.stdout.write(JSON.stringify({
    threshold: THRESHOLD,
    overallLineCov: Number(overall.toFixed(2)),
    fileCount: perFile.length,
    belowThreshold: below,
  }) + '\n');
  if (below.length > 0 || overall < THRESHOLD) {
    process.stderr.write(`coverage-gate: ${below.length} file(s) below ${THRESHOLD}% line coverage; overall ${overall.toFixed(2)}%\n`);
    process.exit(1);
  }
});
process.stdin.on('error', (e) => {
  process.stderr.write(`coverage-gate: stdin error: ${e.message}\n`);
  process.exit(2);
});
