// The harness entrypoint: read every case, answer it with run() from solve.js,
// write the answers back in the cases' order.
//
// V8's incremental marking is switched off before solve.js loads, so the whole
// read runs under it (an entry may tune V8's flags, and the house baseline does).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const module_ = await import(new URL('./solve.js', import.meta.url).href);
const answerOne = module_.run;

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i += 1) answers[i] = answerOne(cases[i].input);

writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
