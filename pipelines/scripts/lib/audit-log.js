// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Append-only JSONL audit log. Each call appends one line.
 * Creates the file (and parent dirs) on first write.
 *
 * @param {string} filePath - absolute or cwd-relative path
 * @param {object} entry - JSON-serialisable audit record
 */
function appendAuditEntry(filePath, entry) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  let prefix = '';
  try {
    const stat = fs.statSync(abs);
    if (stat.size > 0) {
      const buf = Buffer.alloc(1);
      const fd = fs.openSync(abs, 'r');
      try { fs.readSync(fd, buf, 0, 1, stat.size - 1); } finally { fs.closeSync(fd); }
      if (buf[0] !== 0x0A) prefix = '\n';
    }
  } catch { /* file doesn't exist yet — no prefix needed */ }
  fs.appendFileSync(abs, prefix + line, { encoding: 'utf8', mode: 0o600 });
}

module.exports = { appendAuditEntry };
