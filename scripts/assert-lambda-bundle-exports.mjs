import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bundles = [
  'packages/adapter-lambda-edge/dist/origin-request.js',
  'packages/adapter-lambda-edge/dist/companion.js',
  'infra/modules/lambda-edge-injector/dist/origin-request.js',
  'infra/modules/lambda-edge-injector/dist/companion.js',
];

for (const relativePath of bundles) {
  const filename = path.join(root, relativePath);
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);

  assert.deepEqual(
    Object.keys(compiled.exports).sort(),
    ['handler'],
    `${relativePath} must export only the Lambda handler`
  );
}

console.log('Lambda bundle exports verified: handler only');
