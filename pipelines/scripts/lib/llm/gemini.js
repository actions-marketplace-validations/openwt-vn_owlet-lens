// @ts-check
'use strict';

const { BaseLLMProvider } = require('./base.js');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Gemini 2.x output cap (~64k). Clamp so a large shared reviewMaxTokens degrades
// to the ceiling instead of erroring (mirrors anthropic.js / deepseek.js).
const MAX_OUTPUT_TOKENS = 65_536;

class GeminiProvider extends BaseLLMProvider {
  /**
   * @param {{ apiKey: string, defaultModel: string, pricingOverride: Record<string, any>, maxAttempts?: number }} opts
   */
  constructor(opts) {
    super({ ...opts, providerName: 'gemini', errorLabel: 'Gemini' });
    this.supportsTools = true;
  }

  _request({ model, systemPrompt, userPrompt, maxTokens, tools }) {
    const generationConfig = { maxOutputTokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS) };
    const schema = Array.isArray(tools) && tools.length > 0 ? tools[0].input_schema : null;
    if (schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = schema;
    }
    return {
      url: `${(this.apiBaseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')}/${encodeURIComponent(model)}:generateContent`,
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig,
      },
    };
  }

  _extractText(data) {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  _extractUsage(data) {
    return {
      inputTokens: data?.usageMetadata?.promptTokenCount || 0,
      outputTokens: data?.usageMetadata?.candidatesTokenCount || 0,
    };
  }
}

module.exports = { GeminiProvider };
