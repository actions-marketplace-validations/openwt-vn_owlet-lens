// @ts-check
'use strict';

const { redactSecrets } = require('./log-safe.js');

const MAX_BODY_LENGTH = 500;

/**
 * POST findings to a webhook URL. Fire-and-forget with a 10s timeout.
 * Returns { ok: true } on 2xx, { ok: false, status, message } otherwise.
 *
 * @param {string} url
 * @param {{
 *   repo: string,
 *   prId: string,
 *   findings: Array<{ filePath: string, line: number, severity: string, category: string, body: string }>,
 *   costUsd: number,
 *   ts: string,
 * }} payload
 * @returns {Promise<{ ok: boolean, status?: number, message?: string }>}
 */
async function postFindingsWebhook(url, payload) {
  const sanitized = {
    ...payload,
    findings: (payload.findings ?? []).map((f) => ({
      filePath: f.filePath,
      line: f.line,
      severity: f.severity,
      category: f.category,
      body: redactSecrets(String(f.body ?? '')).slice(0, MAX_BODY_LENGTH),
    })),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitized),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (res.ok) {
      res.body?.cancel?.().catch(() => {});
      return { ok: true };
    }
    const body = (await res.text().catch(() => '')).slice(0, 500);
    return { ok: false, status: res.status, message: body };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, message: 'webhook timed out after 10000ms' };
    return { ok: false, message: e?.message ?? 'unknown error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postFindingsWebhook };
