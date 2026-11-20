'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const blueprint = read('render.yaml');
const pkg = JSON.parse(read('package.json'));
const gitignore = read('.gitignore');
const readme = read('README.md');

test('render.yaml declares one web instance, no disk, and the healthcheck', () => {
  assert.match(blueprint, /^services:\s*$/m);
  assert.match(blueprint, /^\s*-\s+type:\s*web\s*$/m);
  assert.match(blueprint, /^\s*name:\s*feria-polyglot\s*$/m);
  assert.match(blueprint, /^\s*runtime:\s*node\s*$/m);
  assert.match(blueprint, /^\s*buildCommand:\s*npm ci && npm test\b/m, 'a red build must not deploy');
  assert.doesNotMatch(blueprint, /^\s*preDeployCommand:/m, 'pre-deploy commands are paid-plan only');
  assert.match(blueprint, /^\s*startCommand:\s*npm start\s*$/m);
  assert.match(blueprint, /^\s*autoDeployTrigger:\s*commit\s*$/m);
  assert.match(blueprint, /^\s*healthCheckPath:\s*\/api\/health\s*$/m);
  assert.match(blueprint, /^\s*numInstances:\s*1\s*$/m);
  assert.match(blueprint, /^\s*branch:\s*render-hardening\b/m, 'auto-deploy must not fall back to the old default branch');
  assert.match(blueprint, /^\s*region:\s*frankfurt\s*$/m);
  assert.doesNotMatch(blueprint, /^\s*maxShutdownDelaySeconds:/m, 'unsupported on free tier');
  assert.doesNotMatch(blueprint, /^\s*disk:/m, 'no persistent disk on Render');
  assert.doesNotMatch(blueprint, /^\s*type:\s*(worker|cron)\s*$/m, 'single-process deployment');
});

test('render.yaml keeps secrets out of source and sets non-secret defaults', () => {
  for (const key of ['FERIA_DM_PIN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    assert.match(
      blueprint,
      new RegExp(`- key:\\s*${key}\\s*\\n\\s*sync:\\s*false\\b`),
      `${key} must be provided in the Render Dashboard`
    );
    assert.doesNotMatch(
      blueprint,
      new RegExp(`- key:\\s*${key}\\s*\\n\\s*value:`),
      `${key} must not have a literal value`
    );
  }
  assert.match(blueprint, /- key:\s*STATE_KEY\s*\n\s*value:\s*feria:campaign-state/);
  assert.match(blueprint, /- key:\s*NODE_VERSION\s*\n\s*value:\s*"22"/);
  assert.match(blueprint, /- key:\s*NODE_ENV\s*\n\s*value:\s*production/);
});

test('package.json scripts and engine match the blueprint', () => {
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.match(pkg.engines.node, />=18/);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'ws']);
});

test('README documents the deployable surface', () => {
  const required = [
    'render.yaml', '/api/health', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'FERIA_DM_PIN', 'npm ci', 'npm test', 'Instance Count', '503', 'buildId', 'Origin'
  ];
  for (const needle of required) {
    assert.ok(readme.includes(needle), `README must mention ${needle}`);
  }
});

test('runtime state cache is ignored while the seed campaign state stays tracked', () => {
  const rules = gitignore.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.ok(rules.includes('data/runtime-state.json'));
  assert.ok(rules.includes('.env.*'), 'local env files must never be committed');
  assert.ok(rules.includes('!.env.example'), 'a sanitised example may stay tracked');
  assert.ok(!rules.some((rule) => rule.includes('campaign-state.json')), 'seed must stay tracked');
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'campaign-state.json')), 'seed file exists');
});

test('browser assets referenced by the page are present in the repo', () => {
  const html = read(path.join('public', 'index.html'));
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 5, 'all browser modules are loaded');
  for (const src of scripts) {
    const target = path.join(ROOT, 'public', src.replace(/^\//, ''));
    assert.ok(fs.existsSync(target), `missing browser asset: ${src}`);
  }
  for (const module of ['audio-protocol', 'dsp-bus-registry', 'peer-session', 'audio-engine', 'app']) {
    assert.ok(scripts.some((src) => src.includes(module)), `missing script tag for ${module}`);
  }
});
