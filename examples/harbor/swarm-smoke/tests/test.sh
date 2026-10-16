#!/bin/bash
set -eu
mkdir -p /logs/verifier
node --input-type=module <<'JS'
import fs from 'node:fs';
let passed = false;
try {
  const answer = JSON.parse(fs.readFileSync('/app/answer.json', 'utf8'));
  passed = answer.result === 3628800 && Object.keys(answer).length === 1 &&
    fs.readFileSync('/app/review.txt', 'utf8').trim().length > 0;
} catch {}
fs.writeFileSync('/logs/verifier/reward.txt', passed ? '1' : '0');
JS
