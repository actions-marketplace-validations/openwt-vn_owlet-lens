'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactDiffSecrets, redactDiffs } = require('../lib/diff-secret-redact.js');

test('redacts Anthropic API key', () => {
  const { redacted, count } = redactDiffSecrets('+const key = "sk-ant-abcdefghij1234567890abcdefghij"');
  assert.ok(!redacted.includes('sk-ant-'));
  assert.ok(redacted.includes('[REDACTED]'));
  assert.ok(count > 0);
});

test('redacts GitHub PAT', () => {
  const { redacted } = redactDiffSecrets('+GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
  assert.ok(!redacted.includes('ghp_'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redacts AWS access key', () => {
  const { redacted } = redactDiffSecrets('+aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('redacts quoted password assignment', () => {
  const { redacted } = redactDiffSecrets('+password: "my-super-secret-pass"');
  assert.ok(!redacted.includes('my-super-secret-pass'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redacts long unquoted password assignment', () => {
  const { redacted } = redactDiffSecrets('+DB_PASSWORD=abcdefgh12345678');
  assert.ok(!redacted.includes('abcdefgh12345678'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('does not redact code reference like password: user.password', () => {
  const code = '+const config = { password: user.password }';
  const { redacted } = redactDiffSecrets(code);
  assert.ok(redacted.includes('user.password'));
});

test('does not redact a token-like identifier assigned another identifier', () => {
  const code = '+const charsPerToken = opts.charsPerToken ?? CONFIG.charsPerToken;';
  const { redacted, count } = redactDiffSecrets(code);
  assert.equal(count, 0);
  assert.equal(redacted, code);
});

test('still redacts an unquoted env var whose name contains an underscore', () => {
  const code = '+GITHUB_TOKEN=abcdefghijklmnop';
  const { redacted } = redactDiffSecrets(code);
  assert.ok(!redacted.includes('abcdefghijklmnop'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('still redacts a quoted camelCase secret key', () => {
  const code = '+accessToken: "abcdefghijklmnop"';
  const { redacted } = redactDiffSecrets(code);
  assert.ok(!redacted.includes('abcdefghijklmnop'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('still redacts unquoted camelCase secret keys', () => {
  for (const line of [
    '+clientSecret: eyJhbGciOiJIUzI1NiIs',
    '+sessionToken=eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIx',
    '+myApiKey=abcdefghijklmnop',
    '+2fa_secret=abcdefghijklmnop',
  ]) {
    const { redacted } = redactDiffSecrets(line);
    assert.ok(redacted.includes('[REDACTED]'), `expected redaction for: ${line}`);
  }
});

test('redacts JSON quoted-key form "password": "value"', () => {
  const { redacted } = redactDiffSecrets('+  "password": "hunter2abc"');
  assert.ok(!redacted.includes('hunter2abc'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redacts YAML quoted-key form', () => {
  const { redacted } = redactDiffSecrets("+  'api_key': 'sk-test-1234abcd5678efgh'");
  assert.ok(!redacted.includes('sk-test-1234abcd5678efgh'));
});

test('redacts secretKey assignment', () => {
  const { redacted } = redactDiffSecrets('+secret_key = "my-very-long-secret-value"');
  assert.ok(!redacted.includes('my-very-long-secret-value'));
});

test('redacts connection string credentials', () => {
  const { redacted } = redactDiffSecrets('+postgres://admin:secretpass123@db.example.com/mydb');
  assert.ok(!redacted.includes('secretpass123'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redacts short connection string passwords (>= 4 chars)', () => {
  const { redacted } = redactDiffSecrets('+mysql://root:pass@localhost/db');
  assert.ok(!redacted.includes('pass@'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redacts PEM private key preserving line count', () => {
  const pem = [
    '+-----BEGIN RSA PRIVATE KEY-----',
    '+MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn',
    '+base64line2',
    '+base64line3',
    '+-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const { redacted, count } = redactDiffSecrets(pem);
  assert.ok(!redacted.includes('MIIEpA'));
  assert.equal(pem.split('\n').length, redacted.split('\n').length);
  assert.ok(count > 0);
});

test('PEM redaction preserves diff line markers', () => {
  const pem = [
    '+-----BEGIN RSA PRIVATE KEY-----',
    '+MIIEpAIBAAK',
    '+-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const { redacted } = redactDiffSecrets(pem);
  const lines = redacted.split('\n');
  for (const line of lines) {
    assert.ok(line.startsWith('+'), `line should keep + prefix: ${line}`);
  }
});

test('PEM redaction handles truncated block (no END marker)', () => {
  const pem = [
    '+-----BEGIN PRIVATE KEY-----',
    '+MIIEpAIBAAK',
    '+base64data',
  ].join('\n');
  const { redacted } = redactDiffSecrets(pem);
  assert.ok(!redacted.includes('MIIEpA'));
  assert.equal(pem.split('\n').length, redacted.split('\n').length);
});

test('redacts indented PEM keys (YAML/k8s style)', () => {
  const pem = [
    '+  tls.key: |',
    '+    -----BEGIN PRIVATE KEY-----',
    '+    MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn',
    '+    -----END PRIVATE KEY-----',
  ].join('\n');
  const { redacted, count } = redactDiffSecrets(pem);
  assert.ok(!redacted.includes('MIIEpA'));
  assert.ok(redacted.includes('[REDACTED-PEM-BEGIN]'));
  assert.ok(redacted.includes('[REDACTED-PEM-END]'));
  assert.ok(count >= 1);
});

// The import tracer feeds whole files, not diffs, so redaction must also work
// when the delimiter sits at column 0 with no diff marker. A fixed-marker
// strip would eat one of the five dashes and miss the block entirely.
test('redacts an unmarked PEM block at column 0 (plain file body)', () => {
  const body = [
    'const key = `',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn',
    'base64line2',
    '-----END RSA PRIVATE KEY-----',
    '`;',
  ].join('\n');
  const { redacted, count } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpA'), 'private key body leaked');
  assert.ok(!redacted.includes('base64line2'), 'private key body leaked');
  assert.ok(redacted.includes('[REDACTED-PEM-BEGIN]'));
  assert.ok(redacted.includes('[REDACTED-PEM-END]'));
  assert.equal(count, 1);
  assert.equal(body.split('\n').length, redacted.split('\n').length);
});

test('redacts an indented, unmarked PEM block (YAML body)', () => {
  const body = [
    'tls:',
    '  key: |',
    '    -----BEGIN PRIVATE KEY-----',
    '    MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn',
    '    -----END PRIVATE KEY-----',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpA'));
  assert.ok(redacted.includes('[REDACTED-PEM-BEGIN]'));
});

test('unmarked PEM redaction keeps surrounding lines intact', () => {
  const body = [
    'const before = 1;',
    '-----BEGIN PRIVATE KEY-----',
    'MIIEpAIBAAK',
    '-----END PRIVATE KEY-----',
    'const after = 2;',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(redacted.startsWith('const before = 1;\n'));
  assert.ok(redacted.endsWith('\nconst after = 2;'));
});

// Inline PEM shapes: the whole block on one physical line. Anchoring the
// delimiter to `^` misses these, and they are common in JSON/YAML config,
// env-style files and test fixtures - exactly what the import tracer feeds in.
test('redacts an escaped single-line PEM (JSON/env style)', () => {
  const body =
    'const cert = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA0Z3VS5JJ\\n-----END RSA PRIVATE KEY-----";';
  const { redacted, count } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked');
  assert.ok(redacted.includes('[REDACTED-PEM]'));
  assert.ok(redacted.startsWith('const cert = "'));
  assert.ok(redacted.endsWith('";'));
  assert.equal(count, 1);
});

test('redacts an inline PEM inside a JSON config value', () => {
  const body =
    '{"tls": {"key": "-----BEGIN EC PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA0Z3VS5JJ\\n-----END EC PRIVATE KEY-----"}}';
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked');
  assert.ok(redacted.includes('[REDACTED-PEM]'));
});

test('redacts a template literal whose BEGIN sits mid-line', () => {
  const body = [
    'const k = `-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0Z3VS5JJ',
    '-----END RSA PRIVATE KEY-----`;',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked');
  const lines = redacted.split('\n');
  assert.ok(lines[0].startsWith('const k = `'), 'prefix before the delimiter is lost');
  assert.ok(lines[2].endsWith('`;'), 'text after the END marker is lost');
  assert.equal(body.split('\n').length, redacted.split('\n').length);
});

test('inline PEM redaction does not consume the rest of the file', () => {
  const body = [
    'const cert = "-----BEGIN PRIVATE KEY-----\\nMIIEpAIBAAK\\n-----END PRIVATE KEY-----";',
    'const untouched = 42;',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(redacted.includes('const untouched = 42;'), 'scanner ran past the closed block');
});

// The END delimiter can share a line with the tail of the key body. Anything
// before it on that line is still key material, so it must not survive; only a
// diff marker / indentation may be kept.
test('redacts a key body that shares a line with the END delimiter', () => {
  const body = [
    'const k = `-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0Z3VS5JJ-----END RSA PRIVATE KEY-----`;',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked before the END marker');
  // The body shared the END line, so it is folded into the END token rather
  // than getting a bare [REDACTED] of its own.
  assert.ok(/\[REDACTED/.test(redacted));
  assert.ok(redacted.includes('[REDACTED-PEM-END]'));
  assert.ok(redacted.startsWith('const k = `'), 'text before the BEGIN marker is lost');
  assert.ok(redacted.endsWith('`;'), 'text after the END marker is lost');
});

test('keeps the diff marker when the key body shares a line with END', () => {
  const body = [
    '+-----BEGIN RSA PRIVATE KEY-----',
    '+MIIEpAIBAAKCAQEA0Z3VS5JJ-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked before the END marker');
  for (const line of redacted.split('\n')) {
    assert.ok(line.startsWith('+'), `line should keep + prefix: ${line}`);
  }
});

test('keeps YAML indentation when the key body shares a line with END', () => {
  const body = [
    '+    -----BEGIN PRIVATE KEY-----',
    '+    MIIEpAIBAAKCAQEA0Z3VS5JJ-----END PRIVATE KEY-----',
  ].join('\n');
  const { redacted } = redactDiffSecrets(body);
  assert.ok(!redacted.includes('MIIEpAIBAAKCAQEA0Z3VS5JJ'), 'key body leaked before the END marker');
  assert.ok(redacted.split('\n')[1].startsWith('+    '), 'indentation lost');
});

test('a body line with no END is redacted whole, marker kept', () => {
  const body = '+MIIEpAIBAAKCAQEA0Z3VS5JJ';
  const { redacted } = redactDiffSecrets(`+-----BEGIN PRIVATE KEY-----\n${body}`);
  assert.equal(redacted, '+[REDACTED-PEM-BEGIN]\n+[REDACTED]');
});

// Table-driven sweep over the delimiter variants and the input shapes that
// have leaked at some point. Each case asserts the four invariants that
// matter: the key body never survives, the block count is right, the line
// count survives, and diff markers survive. Adding a shape here is how the
// input space gets closed rather than patched one report at a time.
test('PEM sweep: every delimiter variant x input shape is redacted', () => {
  const BODY = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn';
  const BODY2 = 'BBBBAIBAAKCAQEA0Z3VS5JJcds3xfn';

  for (const kind of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', '']) {
    const BEG = `-----BEGIN ${kind}PRIVATE KEY-----`;
    const END = `-----END ${kind}PRIVATE KEY-----`;

    const shapes = {
      'line-oriented, diff markers': `+${BEG}\n+${BODY}\n+${END}`,
      'line-oriented, yaml indent': `+    ${BEG}\n+    ${BODY}\n+    ${END}`,
      'line-oriented, plain column 0': `${BEG}\n${BODY}\n${END}`,
      'line-oriented, indented plain': `  ${BEG}\n  ${BODY}\n  ${END}`,
      'inline escaped, source prefix': `const cert = "${BEG}\\n${BODY}\\n${END}";`,
      'inline escaped, json value': `{"k": "${BEG}\\n${BODY}\\n${END}"}`,
      'inline escaped, env style': `KEY=${BEG}\\n${BODY}\\n${END}`,
      'inline real newline, BEGIN ends the line': `const k = \`${BEG}\n${BODY}\n${END}\`;`,
      'inline real newline, body+END share a line': `const k = \`${BEG}\n${BODY}${END}\`;`,
      'body+END share a line, yaml indent': `+    ${BEG}\n+    ${BODY}${END}`,
      'body+END share a line, diff marker': `+${BEG}\n+${BODY}${END}`,
      'two blocks on one physical line': `a = "${BEG}\\n${BODY}\\n${END}"; b = "${BEG}\\n${BODY2}\\n${END}";`,
      'two blocks on consecutive lines': `+${BEG}\n+${BODY}\n+${END}\n+${BEG}\n+${BODY2}\n+${END}`,
      'truncated, diff': `+${BEG}\n+${BODY}`,
      'truncated, trailing newline': `+${BEG}\n+${BODY}\n`,
      'truncated, single line': `+${BEG}`,
      'truncated, inline': `const k = "${BEG}\\n${BODY}`,
      'delimiter at column 0 after a newline': `+${BEG}\n${END}`,
      'stray END with no BEGIN': `const x = "${END}";`,
      'no block at all': 'const x = 1;\nconst y = 2;',
    };

    for (const [shape, input] of Object.entries(shapes)) {
      const label = `${kind || 'generic'} :: ${shape}`;
      const { redacted, count } = redactDiffSecrets(input);

      assert.ok(!redacted.includes(BODY), `key body survived: ${label}`);
      assert.ok(!redacted.includes(BODY2), `second key body survived: ${label}`);
      assert.equal(count, (input.match(/-----BEGIN /g) || []).length, `block count: ${label}`);
      assert.equal(
        redacted.split('\n').length, input.split('\n').length, `line count changed: ${label}`,
      );
      if (input.split('\n').every((l) => l.startsWith('+'))) {
        assert.ok(
          redacted.split('\n').every((l) => l.startsWith('+')),
          `diff marker lost: ${label} -> ${JSON.stringify(redacted)}`,
        );
      }
    }
  }
});

test('two PEM blocks on one physical line are both redacted', () => {
  const a = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn';
  const b = 'BBBBAIBAAKCAQEA0Z3VS5JJcds3xfn';
  const input =
    `a = "-----BEGIN RSA PRIVATE KEY-----\\n${a}\\n-----END RSA PRIVATE KEY-----"; ` +
    `b = "-----BEGIN EC PRIVATE KEY-----\\n${b}\\n-----END EC PRIVATE KEY-----";`;
  const { redacted, count } = redactDiffSecrets(input);
  assert.ok(!redacted.includes(a), 'first key body survived');
  assert.ok(!redacted.includes(b), 'second key body survived');
  assert.equal(count, 2);
  assert.equal(redacted, 'a = "[REDACTED-PEM]"; b = "[REDACTED-PEM]";');
});

test('does not redact sk- inside identifiers', () => {
  const code = '+const risk-assessment-configuration-backup = true';
  const { redacted, count } = redactDiffSecrets(code);
  assert.equal(count, 0);
  assert.equal(redacted, code);
});

test('leaves non-secret code unchanged', () => {
  const code = '+function hello() { return "world"; }';
  const { redacted, count } = redactDiffSecrets(code);
  assert.equal(redacted, code);
  assert.equal(count, 0);
});

test('handles null/undefined input', () => {
  assert.equal(redactDiffSecrets(null).count, 0);
  assert.equal(redactDiffSecrets(null).redacted, '');
  assert.equal(redactDiffSecrets(undefined).count, 0);
  assert.equal(redactDiffSecrets(undefined).redacted, '');
});

test('non-string input returns empty string', () => {
  const result = redactDiffSecrets(42);
  assert.equal(result.redacted, '');
  assert.equal(result.count, 0);
});

test('redactDiffs processes array of diffs without mutation', () => {
  const input = [
    { path: 'a.js', patch: '+const key = "sk-ant-abcdefghij1234567890abcdefghij"' },
    { path: 'b.js', patch: '+console.log("hello")' },
  ];
  const original0 = input[0].patch;
  const { diffs, totalRedacted } = redactDiffs(input);
  assert.ok(totalRedacted > 0);
  assert.ok(!diffs[0].patch.includes('sk-ant-'));
  assert.equal(diffs[1].patch, '+console.log("hello")');
  assert.equal(input[0].patch, original0);
});

test('redactDiffs handles missing patch field', () => {
  const { diffs, totalRedacted } = redactDiffs([{ path: 'x.bin' }]);
  assert.equal(totalRedacted, 0);
  assert.equal(diffs.length, 1);
});
