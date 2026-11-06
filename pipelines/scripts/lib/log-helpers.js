// @ts-check
'use strict';

// Structured stderr loggers shared across the learn pipeline (and any other
// module that wants the project's one-line JSON log convention). Centralised so
// the format stays consistent and isn't re-implemented per file.

/**
 * One-line JSON stderr log with the shared `{ level, msg, ts, ...fields }`
 * shape. The entrypoint and the run-lifecycle helpers both emit this format.
 *
 * @param {string} level
 * @param {string} msg
 * @param {Record<string, any>} [fields]
 */
function logEvent(level, msg, fields = {}) {
  process.stderr.write(JSON.stringify({
    level, msg, ts: new Date().toISOString(), ...fields,
  }) + '\n');
}

/** @param {string} msg @param {Record<string, any>} [extra] */
function logInfo(msg, extra) {
  process.stderr.write(JSON.stringify({ level: 'info', msg, ...extra }) + '\n');
}

/** @param {string} msg @param {Record<string, any>} [extra] */
function logWarn(msg, extra) {
  process.stderr.write(JSON.stringify({ level: 'warn', msg, ...extra }) + '\n');
}

module.exports = { logEvent, logInfo, logWarn };
