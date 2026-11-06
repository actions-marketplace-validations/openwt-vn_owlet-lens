// @ts-check
'use strict';

const { OpenAICompatibleProvider } = require('./openai-base.js');

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
// deepseek reasoning models spend max_tokens on BOTH reasoning and answer
// tokens; an 8k cap let reasoning consume the whole budget and return empty
// content on large prompts. 64k leaves room for reasoning + the findings JSON.
const MAX_OUTPUT_TOKENS = 64_000;

class DeepSeekProvider extends OpenAICompatibleProvider {
  /**
   * @param {{ apiKey: string, defaultModel: string, pricingOverride: Record<string, any>, maxAttempts?: number }} opts
   */
  constructor(opts) {
    super({
      ...opts,
      providerName: 'deepseek',
      errorLabel: 'DeepSeek',
      apiUrl: opts.apiBaseUrl
        ? (() => { const b = opts.apiBaseUrl.replace(/\/+$/, ''); return b.endsWith('/v1/chat/completions') ? b : `${b}/v1/chat/completions`; })()
        : API_URL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  }
}

module.exports = { DeepSeekProvider };
