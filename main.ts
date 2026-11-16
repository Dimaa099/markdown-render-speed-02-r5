// Entry point for the markdown-render-speed-02 harness.
//
// The grader mounts the case set at /input and expects the rendered HTML
// at /output/html.json. Locally the two directories can be overridden
// with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR. Every case is rendered on
// its own through parse() so no state can leak from one case to the next.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function envDir(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const inputDir = envDir('MAKEFUN_INPUT_DIR', '/input');
const outputDir = envDir('MAKEFUN_OUTPUT_DIR', '/output');

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

const rendered = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
