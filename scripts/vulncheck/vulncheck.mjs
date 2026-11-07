#!/usr/bin/env node
// govulncheck with an allowlist.
//
//   node scripts/vulncheck/vulncheck.mjs
//
// Runs `govulncheck -format json ./...` (govulncheck on PATH) and fails if it
// finds a vulnerability the code reaches — a finding whose trace ends in a
// called function, which is exactly what makes plain govulncheck exit 3 — that
// is not listed in scripts/vulncheck/accepted.txt. govulncheck itself has no
// way to accept a finding, and the Ollama module's advisories (server-side, but
// recorded against the whole module with no fixed version) would otherwise
// fail every run. Findings that are only imported or only required are
// reported, not failed, as govulncheck does.
//
// No dependencies: plain Node, plus govulncheck.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const accepted = new Map();
for (const line of readFileSync(join(HERE, 'accepted.txt'), 'utf8').split('\n')) {
    const m = line.match(/^(GO-\d{4}-\d+)\s+(.*)$/);
    if (m) accepted.set(m[1], m[2].trim());
}

let out;
try {
    out = execFileSync('govulncheck', ['-format', 'json', './...'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20,
        env: { ...process.env, GOEXPERIMENT: 'jsonv2' },
    });
} catch (e) {
    console.error(e.code === 'ENOENT'
        ? 'govulncheck is not on PATH: go install golang.org/x/vuln/cmd/govulncheck@v1.9.0'
        : `govulncheck failed: ${e.message}`);
    process.exit(2);
}

// The output is a stream of pretty-printed JSON objects, not one document.
const objects = [];
let depth = 0, start = -1, inString = false, escaped = false;
for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0) objects.push(JSON.parse(out.slice(start, i + 1)));
}

const osv = new Map(objects.filter(o => o.osv).map(o => [o.osv.id, o.osv]));
const level = new Map(); // id -> 'symbol' | 'package' | 'module'
const rank = { module: 0, package: 1, symbol: 2 };
for (const { finding } of objects.filter(o => o.finding)) {
    const top = finding.trace?.[0] ?? {};
    const l = top.function ? 'symbol' : top.package ? 'package' : 'module';
    if (!level.has(finding.osv) || rank[l] > rank[level.get(finding.osv)]) level.set(finding.osv, l);
}

const summary = id => osv.get(id)?.summary ?? '';
const reachable = [...level].filter(([, l]) => l === 'symbol').map(([id]) => id).sort();
const unreviewed = reachable.filter(id => !accepted.has(id));

for (const id of reachable) console.log(`${accepted.has(id) ? 'accepted' : 'NEW     '}  ${id}  ${summary(id)}`);
for (const [id, l] of [...level].filter(([, l]) => l !== 'symbol').sort()) {
    console.log(`not called (${l})  ${id}  ${summary(id)}`);
}
for (const id of accepted.keys()) {
    if (!level.has(id)) console.log(`::warning::${id} is accepted in scripts/vulncheck/accepted.txt but no longer reported — remove it`);
}

if (unreviewed.length) {
    console.error(`\n${unreviewed.length} reachable vulnerability(ies) not reviewed:`);
    for (const id of unreviewed) console.error(`  ✗ ${id}  ${summary(id)}  https://pkg.go.dev/vuln/${id}`);
    console.error('\nUpgrade the module if a fix exists. Only if it truly does not apply, add it to');
    console.error('scripts/vulncheck/accepted.txt AND explain why in .github/SECURITY.md.');
    process.exit(1);
}
console.log(`\n✓ ${reachable.length} reachable finding(s), all reviewed (${accepted.size} accepted)`);
