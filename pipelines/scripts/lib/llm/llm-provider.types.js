// @ts-check
'use strict';

// LLM provider abstract types. JSDoc only — no runtime exports.
// Mirrors lib/providers/provider.types.js for the SCM layer.

/**
 * @typedef {{ inputTokens: number, outputTokens: number }} LLMUsage
 */

/**
 * @typedef {{ inputCost: number, outputCost: number, totalCost: number, cacheCreationCost: number, cacheReadCost: number, priced: boolean }} LLMCost
 */

/**
 * @typedef {{ text: string, usage: LLMUsage, cost: LLMCost }} LLMResponse
 */

/**
 * @typedef {{ model?: string, maxTokens?: number }} LLMOptions
 */

/**
 * @typedef {object} LLMProvider
 * @property {(systemPrompt: string, userPrompt: string, opts?: LLMOptions) => Promise<LLMResponse>} call
 */

module.exports = {};
