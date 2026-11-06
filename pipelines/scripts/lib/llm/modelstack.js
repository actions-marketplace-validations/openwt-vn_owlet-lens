// @ts-check
'use strict';

const { OpenAICompatibleProvider } = require('./openai-base.js');

const API_URL = 'https://api.modelstack.cc/v1/chat/completions';
// Mirror the DeepSeek 64k ceiling: ModelStack fronts reasoning models whose
// max_tokens budget covers BOTH reasoning and answer tokens, so too small a cap
// starves the answer and returns empty content.
const MAX_OUTPUT_TOKENS = 64_000;

class ModelStackProvider extends OpenAICompatibleProvider {
  /**
   * @param {{ apiKey: string, defaultModel: string, pricingOverride: Record<string, any>, maxAttempts?: number }} opts
   */
  constructor(opts) {
    super({
      ...opts,
      providerName: 'modelstack',
      errorLabel: 'ModelStack',
      apiUrl: opts.apiBaseUrl
        ? (() => { const b = opts.apiBaseUrl.replace(/\/+$/, ''); return b.endsWith('/v1/chat/completions') ? b : `${b}/v1/chat/completions`; })()
        : API_URL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  }
}

module.exports = { ModelStackProvider };
