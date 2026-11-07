#!/usr/bin/env node
// Third-party notices for everything Kube Inspector distributes, and the gate
// that keeps GPL-3.0-incompatible code out of it.
//
//   node scripts/notices/notices.mjs --out internal/business/assets/notices/THIRD_PARTY_NOTICES.txt
//   node scripts/notices/notices.mjs --check
//
// What is covered:
//   - every Go module linked into kube-inspector (GUI sidecar) or
//     kube-inspector-cli, for linux, windows and darwin — the union, so the
//     file is the same whichever runner generates it;
//   - the production npm packages bundled into the frontend, and those of the
//     Electron shell (app.asar).
// Electron and Chromium ship their own LICENSE.electron.txt and
// LICENSES.chromium.html beside the app (electron-builder puts them there).
//
// A license is identified from the package's declared SPDX id (npm) or from
// the text of its license files (Go modules declare nothing). Anything not
// recognised, or recognised as incompatible with GPL-3.0, fails the run until
// it is resolved in overrides.json with a reason. --check only classifies (and
// works without the Electron shell's node_modules, using the lockfile's
// declared license); --out also writes the notices file, and then every
// package's license text must be on disk.
//
// No dependencies: plain Node, plus the go toolchain on PATH.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OVERRIDES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'overrides.json'), 'utf8'));

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? resolve(ROOT, args[outIdx + 1]) : null;
if (!CHECK && !OUT) {
    console.error('usage: notices.mjs --check | --out <file>');
    process.exit(2);
}

// ── licenses ────────────────────────────────────────────────────────────────

// Compatible with distribution under GPL-3.0 (FSF's list). OFL-1.1 covers the
// bundled IBM Plex fonts; CC-BY-4.0 is data (e.g. browser tables).
const COMPATIBLE = new Set([
    'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0',
    'Unlicense', 'CC0-1.0', 'Zlib', 'BlueOak-1.0.0', 'Python-2.0', 'OFL-1.1', 'CC-BY-4.0',
    'LGPL-2.1', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-or-later', 'GPL-3.0', 'GPL-3.0-or-later',
    'GPL-2.0-or-later',
    // Not an SPDX id: a public-domain dedication with no licence at all, which
    // only overrides.json assigns (after reading it).
    'LicenseRef-PublicDomain',
]);

// Ordered most specific first. A file may legitimately match several (an
// Apache-2.0 LICENSE with an MIT section for vendored code): all are kept, and
// all must be compatible.
const SIGNATURES = [
    ['Apache-2.0', /Apache License,?\s+Version 2\.0/i],
    ['MPL-2.0', /Mozilla Public License,?\s+(v\.\s*|Version\s+)2\.0/i],
    ['LGPL-3.0', /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/],
    ['LGPL-2.1', /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/],
    // Upper case on purpose: MPL and LGPL mention "GNU General Public License"
    // in title case, and must not read as GPL.
    ['GPL-3.0', /GNU GENERAL PUBLIC LICENSE\s+Version 3/],
    ['GPL-2.0', /GNU GENERAL PUBLIC LICENSE\s+Version 2/],
    ['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE/],
    ['EPL', /Eclipse Public License/i],
    ['CDDL', /COMMON DEVELOPMENT AND DISTRIBUTION LICENSE/i],
    ['SSPL', /Server Side Public License/i],
    ['BUSL', /Business Source License/i],
    ['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
    ['BSD-3-Clause', /Redistribution and use in source and binary forms[\s\S]{0,1500}(Neither the name|endorse or promote)/i],
    ['BSD-2-Clause', /Redistribution and use in source and binary forms, with or without\s+modification, are permitted/i],
    ['ISC', /Permission to use, copy, modify, and(\/or)? distribute this software for any\s+purpose with or without fee is hereby granted, provided that the above\s+copyright notice/i],
    ['0BSD', /Permission to use, copy, modify, and\/or distribute this software for any\s+purpose with or without fee is hereby granted\.\s/i],
    ['Unlicense', /This is free and unencumbered software released into the public domain/i],
    ['CC0-1.0', /CC0 1\.0 Universal/i],
    ['Zlib', /This software is provided 'as-is', without any express or implied\s+warranty/i],
    ['OFL-1.1', /SIL OPEN FONT LICENSE/i],
// License files are hard-wrapped wherever their authors liked ("to any person
// obtaining\na copy"), so every literal space in a signature matches any run
// of whitespace. No signature has a space inside a character class.
].map(([id, re]) => [id, new RegExp(re.source.replace(/ /g, '\\s+'), re.flags)]);

function classify(raw) {
    // Some licenses are quoted as Markdown ("> Redistribution and use ..."),
    // which puts a ">" between words a signature expects to be adjacent.
    const text = raw.replace(/^[ \t]*>[ \t]?/gm, '');
    const ids = [];
    for (const [id, re] of SIGNATURES) {
        if (!re.test(text)) continue;
        // BSD-3 text also matches the BSD-2 signature.
        if (id === 'BSD-2-Clause' && ids.includes('BSD-3-Clause')) continue;
        ids.push(id);
    }
    return ids;
}

// SPDX expression as npm declares it: "MIT", "(MPL-2.0 OR Apache-2.0)",
// "MIT AND CC-BY-4.0". OR needs one compatible member, AND needs all.
function spdxCompatible(expr) {
    const e = expr.replace(/[()]/g, ' ').trim();
    if (/ OR /.test(e)) return e.split(/ OR /).some(p => spdxCompatible(p));
    if (/ AND /.test(e)) return e.split(/ AND /).every(p => spdxCompatible(p));
    return COMPATIBLE.has(e.trim());
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense|notice|copyright|patents)([-._][^/]*)?$/i;

function licenseFiles(dir) {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
        .filter(f => LICENSE_FILE.test(f) && !/\.(go|js|ts|mjs|cjs|json|ya?ml|sh)$/i.test(f))
        .filter(f => statSync(join(dir, f)).isFile())
        .sort()
        .map(f => ({ name: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
}

// ── Go modules ──────────────────────────────────────────────────────────────

function goModules() {
    const tmpl = '{{with .Module}}{{if not .Main}}{{.Path}}\t' +
        '{{if .Replace}}{{.Replace.Version}}{{else}}{{.Version}}{{end}}\t' +
        '{{if .Replace}}{{.Replace.Dir}}{{else}}{{.Dir}}{{end}}{{end}}{{end}}';
    const mods = new Map();
    for (const goos of ['linux', 'windows', 'darwin']) {
        for (const target of [['.'], ['-tags', 'tui', './cmd/tui']]) {
            const out = execFileSync('go', ['list', '-deps', '-f', tmpl, ...target], {
                cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20,
                env: { ...process.env, GOOS: goos, GOARCH: goos === 'darwin' ? 'arm64' : 'amd64', CGO_ENABLED: '1', GOEXPERIMENT: 'jsonv2' },
            });
            for (const line of out.split('\n')) {
                const [path, version, dir] = line.split('\t');
                if (path && !mods.has(path)) mods.set(path, { name: path, version, dir });
            }
        }
    }
    return [...mods.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── npm packages ────────────────────────────────────────────────────────────

function npmPackages(projectDir) {
    const lock = JSON.parse(readFileSync(join(ROOT, projectDir, 'package-lock.json'), 'utf8'));
    const pkgs = [];
    for (const [key, v] of Object.entries(lock.packages)) {
        if (!key || v.dev || v.devOptional || v.link) continue;
        const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        pkgs.push({ name, version: v.version, declared: v.license || '', dir: join(ROOT, projectDir, key) });
    }
    return pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ── resolve ─────────────────────────────────────────────────────────────────

const problems = [];

function resolveComponent(kind, c) {
    const ov = OVERRIDES[kind]?.[c.name];
    let files = licenseFiles(c.dir);
    // A package that ships no licence file (several npm packages do) gets the
    // upstream text from overrides.json, with where it came from.
    if (files.length === 0 && ov?.text) files = [{ name: `LICENSE (from ${ov.source})`, text: ov.text.trim() }];
    const haveDir = c.dir && existsSync(c.dir);

    let license;
    let ok;
    if (ov?.license) {
        license = ov.license;
        ok = spdxCompatible(license);
    } else if (c.declared && !/^SEE LICEN[CS]E/i.test(c.declared)) {
        license = c.declared;
        ok = spdxCompatible(license);
    } else {
        const ids = [...new Set(files.flatMap(f => classify(f.text)))];
        license = ids.join(' AND ');
        ok = ids.length > 0 && ids.every(id => COMPATIBLE.has(id));
    }

    if (!license) problems.push(`${kind} ${c.name}@${c.version}: no license recognised (files: ${files.map(f => f.name).join(', ') || 'none'})`);
    else if (!ok) problems.push(`${kind} ${c.name}@${c.version}: ${license} is not on the GPL-3.0-compatible list`);
    if (!CHECK && !haveDir) problems.push(`${kind} ${c.name}@${c.version}: not on disk (${c.dir}) — run make deps`);
    else if (!CHECK && files.length === 0 && !ov?.noText) {
        problems.push(`${kind} ${c.name}@${c.version}: no license file to reproduce — add an overrides.json entry`);
    }
    return { ...c, license: license || 'UNKNOWN', files };
}

const sections = [
    ['Go modules — compiled into kube-inspector and kube-inspector-cli', 'go', goModules()],
    ['npm packages — bundled into the user interface', 'npm', npmPackages('frontend')],
    ['npm packages — bundled into the desktop shell', 'npm', npmPackages('electron')],
].map(([title, kind, list]) => [title, list.map(c => resolveComponent(kind, c))]);

const tally = {};
for (const [, list] of sections) for (const c of list) tally[c.license] = (tally[c.license] || 0) + 1;
const total = sections.reduce((n, [, l]) => n + l.length, 0);
console.log(`${total} components:`);
for (const [l, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);

if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\nRead each licence before resolving it. A proprietary one looks exactly like "no license');
    console.error('recognised" (primeicons 8 did) — that dependency has to go, not be overridden. A genuinely');
    console.error('compatible one goes in scripts/notices/overrides.json with the reason.');
    process.exit(1);
}
console.log('\n✓ every component is under a GPL-3.0-compatible license');
if (CHECK) process.exit(0);

// ── write ───────────────────────────────────────────────────────────────────

// Identical texts (Apache-2.0 above all) are printed once and referenced.
const texts = new Map(); // hash -> { n, name, text }
const ref = f => {
    const h = createHash('sha256').update(f.text).digest('hex');
    if (!texts.has(h)) texts.set(h, { n: texts.size + 1, name: f.name, text: f.text });
    return `[${texts.get(h).n}]`;
};

const rule = '='.repeat(78);
let body = `KUBE INSPECTOR — THIRD-PARTY SOFTWARE NOTICES

Kube Inspector is free software, licensed under the GNU General Public License
version 3. It is built with the third-party components listed below, each
under its own license. Every license text and NOTICE file follows the list;
identical texts are printed once and referenced by number.

Electron and Chromium, which provide the desktop window, ship their own
notices beside the application: LICENSE.electron.txt and
LICENSES.chromium.html in the installation directory.
`;
for (const [title, list] of sections) {
    body += `\n${rule}\n${title} (${list.length})\n${rule}\n\n`;
    for (const c of list) {
        const refs = c.files.map(ref).join(' ');
        body += `${c.name} ${c.version || ''}\n    ${c.license}${refs ? '  ' + refs : ''}\n`;
    }
}
body += `\n${rule}\nLicense texts and notices\n${rule}\n`;
for (const t of texts.values()) body += `\n[${t.n}] ${t.name}\n${'-'.repeat(78)}\n${t.text}\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body);
console.log(`wrote ${OUT} (${(body.length / 1024).toFixed(0)} KiB, ${texts.size} distinct texts)`);
