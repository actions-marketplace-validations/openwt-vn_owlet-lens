// @ts-check
'use strict';

const { LLMError } = require('../errors.js');

/**
 * Parse an OpenAI-style SSE byte stream into JSON objects.
 *
 * Buffers undecoded bytes across chunks so a JSON payload split mid-line is
 * reassembled. Skips blank lines and `:` comment lines. A `data: [DONE]`
 * sentinel ends iteration. A malformed *complete* `data:` line throws
 * `LLMError` (mirrors the non-stream malformed-JSON behavior).
 *
 * Transport-agnostic: takes any async iterable of Uint8Array so it unit-tests
 * without a real socket.
 *
 * @param {AsyncIterable<Uint8Array>} byteStream
 * @param {string} errorLabel  provider label used in error messages
 * @returns {AsyncGenerator<object>}
 */
async function* parseSSE(byteStream, errorLabel) {
  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * Parse one complete SSE line into a directive. Returns a plain value (never
   * throws a sentinel) so the caller stays `@ts-check` clean:
   *   null            -> skip (blank / comment line)
   *   { done: true }  -> `[DONE]` sentinel, stop iteration
   *   { value: obj }  -> a parsed JSON event to yield
   * @param {string} rawLine
   * @returns {null | { done: true } | { value: object }}
   */
  const parseLine = (rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(':')) return null;
    // Skip non-data SSE field lines (event:/id:/retry:). Only `data:` frames
    // carry the JSON payload; a proxy fronting arbitrary models may emit these,
    // and JSON-parsing them would wrongly kill the stream with a terminal error.
    if (/^(event|id|retry):/.test(line)) return null;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (payload === '[DONE]') return { done: true };
    try {
      return { value: JSON.parse(payload) };
    } catch (e) {
      const err = /** @type {{ message?: string }} */ (e);
      throw new LLMError(`${errorLabel} malformed SSE chunk: ${(err && err.message) || ''}`);
    }
  };

  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const r = parseLine(rawLine);
      if (r === null) continue;
      if ('done' in r) return; // [DONE] — clean end
      yield r.value;
    }
  }
  // Flush a trailing line that arrived without a closing newline.
  if (buffer.length > 0) {
    const r = parseLine(buffer);
    if (r !== null && !('done' in r)) yield r.value;
  }
}

module.exports = { parseSSE };
