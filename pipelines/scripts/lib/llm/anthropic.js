// @ts-check
'use strict';

const { BaseLLMProvider } = require('./base.js');

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
// Prompt caching is GA but the beta header remains accepted for compatibility
// with older accounts. Sending it is a no-op when GA; safer than gating on
// account state.
const BETA_HEADER = 'prompt-caching-2024-07-31';
// Anthropic rejects requests whose max_tokens exceeds the model's output cap
// (Claude 4.x Opus tops out at 32k). Clamp here so an over-large
// reviewMaxTokens (config or YAML) degrades to the ceiling instead of 400-ing
// every call.
const MAX_OUTPUT_TOKENS = 32_000;
// These models return a 400 for a forced tool_choice (`tool` or `any`):
// "tool_choice: type \"tool\" and \"any\" are not supported for this model."
// For them the provider sends `auto` and names the tool in the system prompt.
const NO_FORCED_TOOL_CHOICE_MODELS = Object.freeze([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
]);

/** @param {unknown} model */
function rejectsForcedToolChoice(model) {
  if (typeof model !== 'string') return false;
  return NO_FORCED_TOOL_CHOICE_MODELS.some((m) => model === m || model.startsWith(`${m}-`));
}

/**
 * Downgrade a forced tool_choice to `auto` on models that reject it, and
 * return the system instruction that steers the model to the tool instead.
 *
 * @param {unknown} model
 * @param {any} toolChoice
 * @param {any[] | undefined} tools
 * @returns {{ toolChoice: any, instruction: string | null }}
 */
function adaptToolChoice(model, toolChoice, tools) {
  const forced = toolChoice?.type === 'tool' || toolChoice?.type === 'any';
  if (!forced || !rejectsForcedToolChoice(model)) return { toolChoice, instruction: null };
  const names = toolChoice.type === 'tool'
    ? [toolChoice.name]
    : (Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : []);
  const target = names.length > 0 ? `the ${names.join(' or ')} tool` : 'a tool';
  return {
    toolChoice: { type: 'auto' },
    instruction: `Always answer by calling ${target} exactly once with your complete result. Do not answer in plain text.`,
  };
}

class AnthropicProvider extends BaseLLMProvider {
  /**
   * @param {{ apiKey: string, defaultModel: string, pricingOverride: Record<string, any>, maxAttempts?: number }} opts
   */
  constructor(opts) {
    super({ ...opts, providerName: 'anthropic', errorLabel: 'Anthropic' });
    this.supportsTools = true;
  }

  _request({ model, systemPrompt, userPrompt, maxTokens, tools, toolChoice }) {
    // System prompt is static across review runs of the same project — mark it
    // for ephemeral (5-minute) caching so repeat runs in a PR cycle pay the
    // cached-read rate (~10% of base input) instead of full input. Below the
    // model's minimum cache size, Anthropic silently skips caching.
    const adapted = adaptToolChoice(model, toolChoice, tools);
    return {
      url: this.apiBaseUrl
        ? (() => { const b = this.apiBaseUrl.replace(/\/+$/, ''); return b.endsWith('/v1/messages') ? b : `${b}/v1/messages`; })()
        : DEFAULT_API_URL,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': VERSION,
        'anthropic-beta': BETA_HEADER,
      },
      body: {
        model,
        max_tokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS),
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ...(adapted.instruction ? [{ type: 'text', text: adapted.instruction }] : []),
        ],
        messages: [{ role: 'user', content: userPrompt }],
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
        ...(adapted.toolChoice ? { tool_choice: adapted.toolChoice } : {}),
      },
    };
  }

  _extractText(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    // Tool-use path: when the model invokes a tool, the input arrives as a
    // structured object on the `tool_use` block. Serialize it back to a JSON
    // string so the caller's existing JSON-parse path keeps working uniformly
    // across providers.
    const toolUse = blocks.find((b) => b && b.type === 'tool_use' && b.input);
    if (toolUse) return JSON.stringify(toolUse.input);
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  _extractUsage(data) {
    return {
      inputTokens: data?.usage?.input_tokens || 0,
      outputTokens: data?.usage?.output_tokens || 0,
      cacheCreationInputTokens: data?.usage?.cache_creation_input_tokens || 0,
      cacheReadInputTokens: data?.usage?.cache_read_input_tokens || 0,
    };
  }
}

module.exports = { AnthropicProvider };
