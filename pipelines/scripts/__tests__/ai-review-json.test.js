// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../ai-review.js');

describe('parseArgs', () => {
  it('parseArgs --dry-run sets flag', () => {
    const f = parseArgs(['review', '--dry-run']);
    assert.equal(f.dryRun, true);
    assert.equal(f.subcommand, 'review');
  });

  it('parseArgs without --dry-run leaves flag undefined', () => {
    const f = parseArgs(['review']);
    assert.notEqual(f.dryRun, true);
  });

  it('parseArgs --dry-run combines with --provider= and --config=', () => {
    const f = parseArgs(['review', '--dry-run', '--provider=github', '--config=cfg.yaml']);
    assert.equal(f.dryRun, true);
    assert.equal(f.provider, 'github');
    assert.equal(f.configPath, 'cfg.yaml');
  });

  it('parseArgs --dry-run works for reply subcommand', () => {
    const f = parseArgs(['reply', '--dry-run']);
    assert.equal(f.subcommand, 'reply');
    assert.equal(f.dryRun, true);
  });
});
