// @ts-check
'use strict';

const { isRetryable } = require('../retry.js');
const { safeCause } = require('../log-safe.js');

/**
 * Default failover logger: one-line JSON to stderr (no secrets in the payload).
 * @param {object} entry
 */
function defaultLog(entry) {
  process.stderr.write(JSON.stringify(entry) + '\n');
}

/**
 * Wrap an LLMProvider so a retryable failure on one model id falls over to the
 * next model id in `models`. Intended for the ModelStack proxy, where a single
 * upstream model can 502 while others stay healthy. Each model is tried exactly
 * once — the wrapped provider must be built with `maxAttempts: 1` so its own
 * retry loop does not double up.
 *
 * @param {{ call: (sys: string, user: string, opts?: object) => Promise<any>, supportsTools?: boolean }} provider
 * @param {string[]} models  [primary, ...fallbacks], deduped, length >= 1
 * @param {(entry: object) => void} [log]
 * @returns {{ supportsTools: boolean|undefined, call: (sys: string, user: string, opts?: object) => Promise<any> }}
 */
function wrapModelFallback(provider, models, log = defaultLog) {
  return {
    supportsTools: provider.supportsTools ?? false,
    async call(systemPrompt, userPrompt, opts = {}) {
      let lastErr;
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
          return await provider.call(systemPrompt, userPrompt, { ...opts, model });
        } catch (err) {
          lastErr = err;
          const moreModels = i < models.length - 1;
          if (isRetryable(err) && moreModels) {
            // Narrow to the loose error shape we read for logging instead of an
            // `any` cast — keeps property access type-checked (no type-safety bypass).
            const e = /** @type {{ name?: string, status?: number }} */ (err);
            log({
              level: 'warn',
              msg: 'llm model failover',
              fromModel: model,
              toModel: models[i + 1],
              errName: e?.name,
              status: e?.status,
              ...safeCause(err),
            });
            continue;
          }
          throw err;
        }
      }
      throw lastErr || new Error('wrapModelFallback: empty model list'); // lastErr set when models.length >= 1
    },
  };
}

module.exports = { wrapModelFallback };
