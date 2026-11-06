// @ts-check
'use strict';

const markers = require('./markers.js');

/**
 * Status-transition reply prose, shared by every provider so the wording can't
 * drift between GitHub and Bitbucket. Keyed by thread status.
 * @type {Record<string, string>}
 */
const STATUS_REPLY_TEXT = {
  active: '_Reopening — issue still present after the latest changes._',
  fixed: '_Marked as fixed — issue no longer present in the latest changes._',
  wontfix: "_Marked as won't-fix._",
  resolved: '_Resolved._',
  closed: '_Closed._',
};

/**
 * Per-provider marker codec. Owns every on-wire marker form so providers don't
 * each re-implement (and drift on) status / fingerprint / key marker rendering,
 * status-reply prose, and marker parsing.
 *
 * `style` may be a literal `'html' | 'bitbucket'` or a thunk returning one —
 * Bitbucket resolves its wire style lazily (after a one-time probe), so it
 * passes `() => this._style()` and the codec reads the live value per call.
 * GitHub is always `'html'`.
 *
 * @param {{ prefix: string, style: ('html'|'bitbucket') | (() => 'html'|'bitbucket') }} opts
 */
function makeMarkerCodec({ prefix, style }) {
  const resolveStyle = () => (typeof style === 'function' ? style() : style);
  /** @param {string} s */
  const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

  return {
    get prefix() { return prefix; },
    /** @returns {'html'|'bitbucket'} the currently-resolved wire style */
    style() { return resolveStyle(); },

    /**
     * @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status
     * @param {string} [fpHash]
     */
    status(status, fpHash) {
      return markers.serializeMarker({ prefix, status, fingerprintHash: fpHash, style: resolveStyle() });
    },

    /** @param {string} key bare versioned key marker (e.g. `summary`, `verdict`) */
    key(key) {
      return markers.serializeKeyMarker({ prefix, key, style: resolveStyle() });
    },

    /**
     * Append a status (+optional fingerprint) marker block to a body.
     * @param {string} body
     * @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status
     * @param {string} [fpHash]
     */
    appendStatus(body, status, fpHash) {
      return `${body}\n\n${this.status(status, fpHash)}`;
    },

    /**
     * Append a key marker block to a body.
     * @param {string} body @param {string} key
     */
    appendKey(body, key) {
      return `${body}\n\n${this.key(key)}`;
    },

    /** Status-transition reply prose, no marker. @param {string} status */
    statusReplyText(status) {
      return STATUS_REPLY_TEXT[status] ?? `_Status: ${status}._`;
    },

    /**
     * Full status-transition reply body: prose + status marker.
     * @param {'active'|'fixed'|'wontfix'|'resolved'|'closed'} status
     */
    statusReplyBody(status) {
      return this.appendStatus(this.statusReplyText(status), status);
    },

    /** @param {string} body */
    parse(body) { return markers.parseMarkers(body, prefix); },

    /** @param {string} body true when the body carries any of our markers */
    has(body) { return markers.hasMarker(body, prefix); },

    /**
     * True when the body carries a specific versioned key marker, in either
     * wire form. The `(?![\w-])` boundary keeps `summary` from matching
     * `summary-extended` (and vice-versa).
     * @param {string} body @param {string} key
     */
    hasKey(body, key) {
      const re = new RegExp(`${esc(prefix)}:${markers.VERSION}:${esc(key)}(?![\\w-])`);
      return re.test(body ?? '');
    },

    /**
     * Rewrite any HTML-comment key markers in a body to the resolved wire style
     * (the Bitbucket-visibility fix). No-op when style is `html`.
     * @param {string} body
     */
    restyle(body) { return markers.restyleKeyMarkers(body, prefix, resolveStyle()); },
  };
}

module.exports = { makeMarkerCodec, STATUS_REPLY_TEXT };
