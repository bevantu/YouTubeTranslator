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

test('subtitles stay centered while the side panel is docked and long lines wrap', () => {
  const css = readFileSync(join(root, 'content/content.css'), 'utf8');
  const panel = readFileSync(join(root, 'content/panel.js'), 'utf8');
  assert.match(css, /\.yb-subtitle-container\s*\{[\s\S]*?left:\s*50%;[\s\S]*?right:\s*auto;/);
  assert.match(css, /\.yb-panel\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*100%;/);
  assert.doesNotMatch(css, /\.yb-panel\s*\{[^}]*position:\s*fixed;/);
  assert.match(css, /\.yb-panel-subtitle-entry[\s\S]*?height:\s*auto;/);
  assert.match(css, /\.yb-panel-subtitle-entry \.yb-panel-sub-original,[\s\S]*?white-space:\s*normal;/);
  assert.match(panel, /querySelector\('#secondary-inner'\)/);
  assert.match(panel, /secondaryInner\.insertBefore\(this\.panel,\s*secondaryInner\.firstElementChild\)/);
});
