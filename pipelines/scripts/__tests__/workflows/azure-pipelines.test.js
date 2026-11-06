'use strict';

/**
 * The Azure DevOps TL-gate pipeline: examples/azure-pipelines-tl-gate.yml.
 *
 * Azure Repos has no YAML trigger for a manual build ("If you set the policy
 * trigger to Manual, users must queue the build themselves"), so the button is a
 * second build-validation policy and this file is what that policy runs. The one
 * thing code must verify is that the pipeline sets AI_REVIEW_TL_PRESSED itself,
 * and that nothing turns it on by itself.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..', '..', '..', '..');
const pipelinePath = path.join(root, 'examples', 'azure-pipelines-tl-gate.yml');

function load(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

test('azure-pipelines-tl-gate.yml parses and declares no automatic trigger', () => {
  const pipeline = load(pipelinePath);

  assert.equal(pipeline.trigger, 'none', 'only a Manual policy build may queue this pipeline');
  assert.equal(pipeline.pr, 'none', 'a PR trigger would open the gate on every push');
});

test('the pipeline exports AI_REVIEW_TL_PRESSED itself', () => {
  const pipeline = load(pipelinePath);

  assert.equal(
    pipeline.variables.AI_REVIEW_TL_PRESSED,
    'true',
    'Azure reports no variable that distinguishes a manually queued build from a push, so the pipeline declares the press',
  );
});

test('the press variable is passed to the CLI step, not just declared', () => {
  const pipeline = load(pipelinePath);
  const run = pipeline.steps.find((s) => typeof s.script === 'string' && s.script.includes('ai-review.js'));

  assert.ok(run, 'a step must run the CLI');
  assert.ok(
    run.env.AI_REVIEW_TL_PRESSED.includes('$(AI_REVIEW_TL_PRESSED)'),
    'a variable declared at the top is not automatically an env var for a script step',
  );
});

test('the review step uses the azure-devops provider', () => {
  const pipeline = load(pipelinePath);
  const run = pipeline.steps.find((s) => typeof s.script === 'string' && s.script.includes('ai-review.js'));

  assert.ok(run.script.includes('review'), 'the button opens the gate for the review pass');
  assert.ok(run.script.includes('--provider=azure-devops'));
  assert.ok(!run.script.includes('reply'), 'reply is not gated');
});

test('the pipeline checks out self and installs dependencies before running', () => {
  const pipeline = load(pipelinePath);
  const scripts = pipeline.steps.filter((s) => typeof s.script === 'string').map((s) => s.script).join('\n');

  assert.ok(pipeline.steps.some((s) => s.checkout === 'self'), 'the review needs the working tree');
  assert.ok(scripts.includes('npm ci'), 'the CLI runs from source, so deps must be installed');
});

test('the pipeline pins a node version, matching the other templates', () => {
  const pipeline = load(pipelinePath);
  const nodeTool = pipeline.steps.find((s) => typeof s.task === 'string' && s.task.startsWith('NodeTool'));

  assert.ok(nodeTool, 'a NodeTool task must pin the runtime');
  assert.ok(String(nodeTool.inputs.versionSpec).includes('2'), 'engines require node >= 20.10');
});
