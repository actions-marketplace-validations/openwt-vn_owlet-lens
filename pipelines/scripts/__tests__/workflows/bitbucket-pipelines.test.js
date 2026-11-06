const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..', '..', '..', '..');
const pipelinePath = path.join(root, 'bitbucket-pipelines.yml');

function load(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

test('bitbucket-pipelines.yml defines pull-requests and custom learn', () => {
  const bb = load(pipelinePath);
  assert.ok(bb.pipelines['pull-requests']['**'], 'pull-requests.** must be present');
  assert.ok(bb.pipelines.custom.learn, 'custom.learn must be present');
});

// --- TL gate: the manual step that turns the AI on (review.tlGate) ------------

test('pull-request pipeline ends with a manual "turn AI review on" step', () => {
  const bb = load(pipelinePath);
  const steps = bb.pipelines['pull-requests']['**'];

  assert.equal(steps.length, 2, 'the automatic review step plus the manual TL step');
  const tl = steps[1].step;
  assert.equal(tl.trigger, 'manual', 'the TL step must be the button the gate watches for');
  assert.match(tl.name, /team lead/i);
});

test('the manual step cannot be first — Bitbucket rejects a manual first step', () => {
  const bb = load(pipelinePath);
  assert.notEqual(bb.pipelines['pull-requests']['**'][0].step.trigger, 'manual');
});

test('the manual step sets AI_REVIEW_TL_PRESSED itself, since the triggerer UUID is set on every step', () => {
  const bb = load(pipelinePath);
  const script = [].concat(bb.pipelines['pull-requests']['**'][1].step.script).join('\n');

  assert.ok(
    script.includes('export AI_REVIEW_TL_PRESSED=true'),
    'the manual step must export AI_REVIEW_TL_PRESSED — BITBUCKET_STEP_TRIGGERER_UUID is also set in the automatic step, so it alone cannot mark a press',
  );
});

test('the manual step runs review with the bitbucket provider and tolerates exit codes 0 and 1', () => {
  const bb = load(pipelinePath);
  const script = [].concat(bb.pipelines['pull-requests']['**'][1].step.script).join('\n');

  assert.ok(script.includes('review --provider=bitbucket'), 'a press reviews the PR');
  assert.ok(script.includes('-eq 0') && script.includes('-eq 1'), 'a press that posts findings is success');
  assert.ok(script.includes('exit "$code"'), 'errors must still fail the step');
  assert.ok(
    script.includes('AI_REVIEW_TL_PRESSED') || script.includes('AI_REVIEW_CMD'),
    'the press variable must reach the CLI through the step environment',
  );
});

test('the manual step installs dependencies, since each step is its own container', () => {
  const bb = load(pipelinePath);
  const script = [].concat(bb.pipelines['pull-requests']['**'][1].step.script);
  assert.ok(script.includes('npm ci'), 'npm ci is not shared between steps');
});

test('pull-request step tolerates exit codes 0 and 1 for reply and review', () => {
  const bb = load(pipelinePath);
  const prStep = bb.pipelines['pull-requests']['**'][0].step;
  const script = [].concat(prStep.script).join('\n');
  assert.ok(script.includes('for cmd in reply review'), 'should run reply and review');
  assert.ok(script.includes('node pipelines/scripts/ai-review.js'), 'should invoke ai-review.js');
  assert.ok(script.includes('--provider=bitbucket'), 'should use bitbucket provider');
  assert.ok(script.includes('-eq 0') && script.includes('-eq 1'), 'should treat 0 and 1 as success');
  assert.ok(script.includes('exit "$fail"'), 'should propagate the fail code');
});

test('custom learn step tolerates exit codes 0 and 1', () => {
  const bb = load(pipelinePath);
  const learnStep = bb.pipelines.custom.learn[0].step;
  const script = [].concat(learnStep.script).join('\n');
  assert.ok(script.includes('learn'), 'should invoke learn');
  assert.ok(script.includes('--provider=bitbucket'), 'should use bitbucket provider');
  assert.ok(
    script.includes('-eq 0') && script.includes('-eq 1'),
    'learn must treat exit codes 0 and 1 as success (1 means a proposal PR was opened)',
  );
  assert.ok(script.includes('exit "$code"'), 'learn must still fail the step on 2-5');
});
