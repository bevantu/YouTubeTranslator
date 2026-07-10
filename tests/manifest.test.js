const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('manifest references files that exist', () => {
  const paths = [];
  for (const script of manifest.content_scripts || []) {
    paths.push(...(script.js || []), ...(script.css || []));
  }
  if (manifest.background?.service_worker) paths.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) paths.push(manifest.action.default_popup);
  if (manifest.options_page) paths.push(manifest.options_page);

  for (const path of paths) {
    assert.equal(existsSync(join(root, path)), true, `Missing manifest file: ${path}`);
  }
});

test('content script file lists do not contain duplicates', () => {
  for (const script of manifest.content_scripts || []) {
    for (const key of ['js', 'css']) {
      const files = script[key] || [];
      assert.equal(new Set(files).size, files.length, `Duplicate ${key} entry: ${files.join(', ')}`);
    }
  }
});

test('subtitle optimizer loads after the manager and before the entry point', () => {
  const youtubeScript = (manifest.content_scripts || []).find(script =>
    (script.matches || []).some(match => match.includes('youtube.com')) &&
    (script.js || []).includes('content/subtitle.js')
  );
  assert.ok(youtubeScript, 'YouTube content script is missing');
  const files = youtubeScript.js;
  const managerIndex = files.indexOf('content/subtitle.js');
  const optimizerIndex = files.indexOf('content/subtitleOptimizer.js');
  const entryIndex = files.indexOf('content/content.js');
  assert.ok(managerIndex >= 0 && optimizerIndex > managerIndex && entryIndex > optimizerIndex);
});

test('responsive subtitle and panel anchors are explicit in both text directions', () => {
  const css = readFileSync(join(root, 'content/content.css'), 'utf8');
  assert.match(css, /\.yb-subtitle-container\s*\{[\s\S]*?left:\s*50%;[\s\S]*?right:\s*auto;/);
  assert.match(css, /\.yb-panel\s*\{\s*right:\s*0;\s*left:\s*auto;/);
  assert.match(css, /\[dir="rtl"\]\s+\.yb-panel\s*\{\s*right:\s*auto;\s*left:\s*0;/);
});
