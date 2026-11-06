// @ts-check
'use strict';

// Everything `runReview` reads off the working folder before the review pass:
// CODEOWNERS (logged only), traced imports, coding standards, context paths and
// learned suppressions. Split out of ai-review.js so the review fingerprint can
// hash the standards before any LLM client is built (ADR-0015).

const { traceImports } = require('./import-tracer.js');
const { loadCodingStandards, loadContextPaths, loadCodingStandardsArray, matchStandardsForFiles } = require('./context-loader.js');
const { extractSuppressionRules, renderSuppressionSection } = require('./learn/suppression-context.js');
const { loadCodeowners, findOwners } = require('./codeowners.js');

/**
 * @param {{
 *   cwd: string,
 *   config: any,
 *   diffs: Array<{ path: string }>,
 *   log: (level: string, msg: string, fields?: Record<string, any>) => void,
 * }} opts
 * @returns {{ codingStandards: any, projectContext: any, suppressionContext: string, tracedImports: any[] }}
 */
function loadReviewContext({ cwd, config, diffs, log }) {
  const changedPaths = diffs.map((d) => d.path);
  const codeowners = loadCodeowners(cwd);
  if (codeowners) {
    const ownerMap = findOwners(changedPaths, codeowners.rules);
    if (ownerMap.size > 0) {
      const ownerSummary = Object.create(null);
      for (const [owner, files] of ownerMap) ownerSummary[owner] = files.length;
      log('info', 'review.codeowners', { file: codeowners.path, owners: ownerSummary });
    }
  }

  const { imports: tracedImports, totalRedacted: tracedRedacted, excluded: tracedExcluded } =
    traceImports(diffs, cwd, { excludePatterns: config.paths?.exclude });
  if (tracedImports.length > 0) {
    log('info', 'review.imports.traced', { count: tracedImports.length, files: tracedImports.map((t) => t.path) });
  }
  if (tracedExcluded.length > 0) {
    log('info', 'review.imports.excluded', { count: tracedExcluded.length, files: tracedExcluded });
  }
  if (tracedRedacted > 0) {
    log('warn', 'imports.secrets.redacted', { count: tracedRedacted });
  }
  let codingStandards;
  if (config.review._codingStandards && config.review._codingStandards.length > 0) {
    const loaded = loadCodingStandardsArray(cwd, config.review._codingStandards);
    codingStandards = matchStandardsForFiles(loaded, changedPaths);
    if (loaded.length > 0) {
      log('info', 'review.codingStandards.glob', { entries: loaded.length, matched: codingStandards.length > 0 });
    }
  } else {
    codingStandards = loadCodingStandards(cwd, config.review.codingStandardsPath);
  }
  const projectContext = loadContextPaths(cwd, config.review.contextPaths);
  const suppressionRules = extractSuppressionRules(loadCodingStandards(cwd, config.review.codingStandardsPath));
  const suppressionContext = renderSuppressionSection(suppressionRules);
  if (suppressionRules.length > 0) {
    log('info', 'review.suppression.loaded', { count: suppressionRules.length });
  }
  return { codingStandards, projectContext, suppressionContext, tracedImports };
}

module.exports = { loadReviewContext };
