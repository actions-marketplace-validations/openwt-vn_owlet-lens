const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..', '..', '..', '..');
const templatePath = path.join(root, 'examples', 'gitlab-ci.yml');
const configPath = path.join(root, 'examples', 'ai-review.gitlab.yaml');

function load(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

test('gitlab-ci.yml defines review, reply, and learn jobs', () => {
  const ci = load(templatePath);

  for (const job of ['owlet-lens-review', 'owlet-lens-reply', 'owlet-lens-learn']) {
    assert.ok(ci[job], `${job} job must be present`);
  }
});

// --- TL gate: the manual job that turns the AI on (review.tlGate) -------------

test('a manual TL job exists — it is what CI_JOB_MANUAL marks as a press', () => {
  const ci = load(templatePath);

  assert.ok(ci['owlet-lens-review-tl'], 'owlet-lens-review-tl job must be present');
  assert.equal(ci['owlet-lens-review-tl'].when, 'manual');
});

test('the TL job is allowed to fail, so a denied press stays a green pipeline', () => {
  const ci = load(templatePath);

  assert.equal(
    ci['owlet-lens-review-tl'].allow_failure,
    true,
    'a non-lead press exits 0 and the note write is best-effort; the job must not block the MR',
  );
});

test('the TL job runs review, not reply — reply is not gated', () => {
  const ci = load(templatePath);

  assert.equal(ci['owlet-lens-review-tl'].variables.AI_REVIEW_CMD, 'review');
  assert.ok([].concat(ci['owlet-lens-review-tl'].script).join('\n').includes('--provider=gitlab'));
});

test('the TL job runs only on merge request pipelines, like the other review jobs', () => {
  const ci = load(templatePath);
  const rules = ci['owlet-lens-review-tl'].rules;

  assert.ok(
    rules.some((r) => r.if && r.if.includes('merge_request_event')),
    'a schedule pipeline has no team lead to press the button',
  );
});

test('nothing needs the TL job — a press is optional, so the gate must not block on it', () => {
  const ci = load(templatePath);
  for (const [name, job] of Object.entries(ci)) {
    const needs = [].concat(job.needs || []).map((n) => (typeof n === 'string' ? n : n.job));
    assert.ok(
      !needs.includes('owlet-lens-review-tl'),
      `${name} must not need owlet-lens-review-tl: an unpressed manual job would stall the pipeline`,
    );
  }
});

test('the TL job reuses the shared base and runner script', () => {
  const ci = load(templatePath);
  const job = ci['owlet-lens-review-tl'];

  assert.equal(job.extends, '.ai-review-base');
  assert.equal(job.stage, 'test');
  assert.deepEqual(job.script, ci['owlet-lens-review'].script);
});

test('review and reply jobs run on merge request pipelines with the gitlab provider', () => {
  const ci = load(templatePath);

  for (const job of ['owlet-lens-review', 'owlet-lens-reply']) {
    const rules = ci[job].rules;
    assert.ok(Array.isArray(rules) && rules.length > 0, `${job} must declare rules`);
    assert.ok(
      rules.some((r) => r.if && r.if.includes('merge_request_event')),
      `${job} must be gated on $CI_PIPELINE_SOURCE == "merge_request_event"`,
    );

    const script = [].concat(ci[job].script).join('\n');
    assert.ok(script.includes('--provider=gitlab'), `${job} must run the gitlab provider`);
  }
});

test('learn job runs on scheduled pipelines with the gitlab provider', () => {
  const ci = load(templatePath);
  const rules = ci['owlet-lens-learn'].rules;

  assert.ok(
    rules.some((r) => r.if && r.if.includes('schedule')),
    'learn must be gated on $CI_PIPELINE_SOURCE == "schedule"',
  );
  assert.ok(
    [].concat(ci['owlet-lens-learn'].script).join('\n').includes('--provider=gitlab'),
    'learn must run the gitlab provider',
  );
});

test('review job runs after the reply job', () => {
  const ci = load(templatePath);
  const needs = [].concat(ci['owlet-lens-review'].needs || []);

  assert.ok(needs.includes('owlet-lens-reply'), 'owlet-lens-review must depend on owlet-lens-reply');
});

test('each ai-code job runs its subcommand and tolerates exit codes 0 and 1', () => {
  const ci = load(templatePath);
  const cmds = { 'owlet-lens-reply': 'reply', 'owlet-lens-review': 'review', 'owlet-lens-learn': 'learn' };

  for (const [job, cmd] of Object.entries(cmds)) {
    assert.equal(ci[job].variables.AI_REVIEW_CMD, cmd, `${job} must set AI_REVIEW_CMD=${cmd}`);
    const script = [].concat(ci[job].script).join('\n');
    assert.ok(script.includes('--provider=gitlab'), `${job} must run the gitlab provider`);
    assert.ok(
      script.includes('-eq 0') && script.includes('-eq 1'),
      `${job} must treat exit codes 0 and 1 as success (findings are not CI failures)`,
    );
  }
});

test('gitlab config example targets the gitlab review provider', () => {
  const config = load(configPath);

  assert.equal(config.provider, 'gitlab');
});

test('owlet-lens-reply is allowed to fail so review still runs', () => {
  const ci = load(templatePath);

  assert.equal(
    ci['owlet-lens-reply'].allow_failure,
    true,
    'owlet-lens-reply must set allow_failure: true so a reply error does not skip review',
  );
});

test('reviewer clone skips credential injection when the URL already has one', () => {
  const ci = load(templatePath);
  const before = [].concat(ci['.ai-review-base'].before_script).join('\n');

  assert.ok(
    before.includes('/@/!'),
    'clone must skip the sed substitution when AI_REVIEW_REPO already contains credentials',
  );
});
