const { readFileSync, readdirSync } = require('node:fs');
const { extname, join, relative } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(fullPath));
    else if (extname(entry.name) === '.js') files.push(fullPath);
  }
  return files;
}

const files = collectJavaScriptFiles(root);
for (const file of files) {
  try {
    new vm.Script(readFileSync(file, 'utf8'), { filename: relative(root, file) });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
