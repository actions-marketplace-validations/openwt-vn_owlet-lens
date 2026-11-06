// @ts-check
'use strict';

const { BaseLLMProvider, DEFAULT_MAX_TOKENS, getFetchTimeoutMs, getFetchDispatcher } = require('./base.js');
const { ProviderError, LLMError } = require('../errors.js');
const { withRetry } = require('../retry.js');
const { calculateCost } = require('./pricing.js');
const { parseSSE } = require('./sse-parse.js');

/**
 * Adapt a WHATWG ReadableStream (Node fetch body) into an async iterable of
 * Uint8Array. Uses getReader() rather than async-iterating the stream directly
 * because getReader is stable on Node >= 20.10.
 * @param {ReadableStream<Uint8Array>} readable
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* readableToBytes(readable) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Shared base for OpenAI-compatible chat-completions providers (DeepSeek,
 * ModelStack). Always streams: `stream: true` + `stream_options.include_usage`
 * so the first SSE chunk arrives in seconds and the socket stays active past a
 * proxy's ~5-minute first-byte/idle timeout. Accumulates `delta.content` and
 * reads the terminal usage frame, then returns the same shape as the
 * non-streaming base.
 */
class OpenAICompatibleProvider extends BaseLLMProvider {
  /**
   * @param {{
   *   apiKey: string, defaultModel: string, pricingOverride?: Record<string, any>,
   *   maxAttempts?: number, providerName: string, errorLabel: string,
   *   apiUrl: string, maxOutputTokens: number,
   * }} opts
   */
  constructor(opts) {
    super(opts);
    this.apiUrl = opts.apiUrl;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.supportsTools = true;
  }

  /**
   * @param {{
   *   model: string,
   *   systemPrompt: string,
   *   userPrompt: string,
   *   maxTokens: number,
   *   tools?: any[],
   *   toolChoice?: any,
   *   responseFormat?: 'json',
   * }} args
   * @returns {{ url: string, headers: Record<string, string>, body: object }}
   */
  _request({ model, systemPrompt, userPrompt, maxTokens, tools, responseFormat }) {
    // Force JSON mode when the caller uses tool-style structured output OR
    // explicitly asks for JSON (e.g. the reply evaluator).
    const jsonMode = (Array.isArray(tools) && tools.length > 0) || responseFormat === 'json';
    return {
      url: this.apiUrl,
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: {
        model,
        // Clamp so a large shared reviewMaxTokens can't exceed the model's cap.
        // These are reasoning models whose max_tokens budget covers BOTH
        // reasoning and answer tokens; too small a cap returns empty content.
        max_tokens: Math.min(maxTokens, this.maxOutputTokens),
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      },
    };
  }

  /**
   * @param {any} data
   * @returns {string}
   */
  _extractText(data) {
    return data?.choices?.[0]?.message?.content || '';
  }

  /**
   * @param {any} data
   * @returns {{ inputTokens: number, outputTokens: number }}
   */
  _extractUsage(data) {
    return {
      inputTokens: data?.usage?.prompt_tokens || 0,
      outputTokens: data?.usage?.completion_tokens || 0,
    };
  }

  /**
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {{ model?: string, maxTokens?: number, tools?: any[], toolChoice?: any, responseFormat?: 'json' }} [opts]
   */
  async call(systemPrompt, userPrompt, opts = {}) {
    const model = opts.model || this.defaultModel;
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const { url, headers, body } = this._request({
      model, systemPrompt, userPrompt, maxTokens,
      tools: opts.tools, toolChoice: opts.toolChoice, responseFormat: opts.responseFormat,
    });

    const aggregated = await withRetry(async () => {
      // Mirror the non-streaming path's transport hardening (base.js): an
      // absolute AbortSignal ceiling plus an undici dispatcher whose
      // headers/body timeouts guard against a stalled connection. bodyTimeout
      // is inactivity-based, so a steadily-flowing stream is never cut — only
      // a hung one — which is exactly what streaming needs. The absolute
      // ceiling stays generous (default 10min, override AI_REVIEW_LLM_TIMEOUT_MS).
      const timeoutMs = getFetchTimeoutMs();
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
        dispatcher: getFetchDispatcher(timeoutMs),
      });
      await this.mapHttpError(res);
      if (!res.body) {
        throw new ProviderError(`${this.errorLabel}: streaming response has no body`, {
          provider: this.providerName, retryable: true,
        });
      }

      let content = '';
      let usage;
      let sawContent = false;
      try {
        for await (const rawEvt of parseSSE(readableToBytes(res.body), this.errorLabel)) {
          // parseSSE yields `object` (payload shape is provider-defined); narrow
          // to the OpenAI-style SSE frame shape we expect instead of `as any`.
          const evt = /** @type {{ choices?: Array<{ delta?: { content?: string } }>, usage?: any }} */ (rawEvt);
          const delta = evt?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) { content += delta; sawContent = true; }
          if (evt?.usage) usage = evt.usage;
        }
      } catch (err) {
        // A malformed chunk (LLMError) is terminal — surface it. Any other
        // failure is a transport break: reclassify retryable so withRetry
        // re-opens the whole call.
        if (err instanceof LLMError) throw err;
        const e = /** @type {{ message?: string }} */ (err);
        throw new ProviderError(`${this.errorLabel}: stream interrupted (${(e && e.message) || 'unknown'})`, {
          provider: this.providerName, retryable: true,
        });
      }

      if (!sawContent && !usage) {
        // Produced nothing and no terminal usage frame — treat as a dropped
        // connection and retry the whole call.
        throw new ProviderError(`${this.errorLabel}: stream ended empty`, {
          provider: this.providerName, retryable: true,
        });
      }

      return { choices: [{ message: { content } }], usage };
    }, { maxAttempts: this.maxAttempts, label: this.providerName });

    const text = this._extractText(aggregated);
    const usage = this._extractUsage(aggregated);
    const cost = calculateCost(this.providerName, model, usage, this.pricingOverride);
    return { text, usage, cost, model };
  }
}

module.exports = { OpenAICompatibleProvider, readableToBytes };
