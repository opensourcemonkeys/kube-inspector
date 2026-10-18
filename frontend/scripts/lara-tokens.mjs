#!/usr/bin/env node
// Generates src/theme-lara-tokens.css: every colour lara-dark-cyan hardcodes,
// re-pointed at the app's palette tokens.
//
// Why: lara paints its dark palette as literals — slate surfaces (#1f2937),
// white-at-87% text, a cyan accent — so any state theme-monolith.css does not
// override shows lara's colour. On a dark theme that mostly hides (white ink on
// graphite looks right); on the light theme it is white text on a white panel.
// Rather than chase each one by hand, this re-declares lara's own rules with
// tokens in place of the literals.
//
// The output goes inside `@layer primereact`, the layer lara itself uses: it
// overrides lara by coming later in the same layer, and every unlayered rule
// in theme-monolith.css still beats it regardless of specificity. So it only
// changes what lara would have painted, never one of our own overrides.
//
// Re-run after upgrading primereact:  npm run theme:lara
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = require.resolve('primereact/resources/themes/lara-dark-cyan/theme.css');
const target = join(here, '..', 'src', 'theme-lara-tokens.css');

// Only the components the app renders; the rest would be dead weight.
const USED = /\.p-(component|link|disabled|focus|highlight|datatable|column-filter|sortable-column|row-toggler|checkbox|dropdown|multiselect|inputtext|inputnumber|input-icon|icon-field|listbox|slider|button|speeddial|toast|dialog|overlaypanel|tooltip|tag|badge|menu|menubar|contextmenu|submenu|menuitem|tabview|progressbar|splitter|colorpicker|message|inline-message|skeleton|paginator|virtualscroller|toggleable)|placeholder/;
const SKIP = /p-(variant-filled|input-filled|button-(help|success|info|contrast|help|raised)|button-group|splitbutton|breadcrumb|tieredmenu|megamenu|panelmenu|slidemenu|tabmenu|steps|datepicker|calendar|tree|treetable|dataview|chips?\b|autocomplete|password|cascadeselect|treeselect|image|scrolltop|editor)/;

const ACCENT_A = (a) => `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)`;
const INK_A = (a) => `color-mix(in srgb, var(--ink) ${Math.round(a * 100)}%, transparent)`;

/** The literal → token map. `prop` decides the few colours whose role depends on it. */
function mapValue(prop, value) {
    // lara's popup shadow (three stacked black layers) → our popover shadow.
    if (prop === 'box-shadow' && /rgba\(0, 0, 0, 0\.2\)/.test(value)) return 'var(--shadow-2)';
    const isBg = prop.startsWith('background');
    let v = value
        .replace(/rgba\(255, 255, 255, 0\.87\)/g, 'var(--ink)')
        .replace(/rgba\(255, 255, 255, 0\.6\)/g, 'var(--ink-2)')
        .replace(/rgba\(255, 255, 255, 0\.03\)/g, 'var(--screen-2)')
        .replace(/rgba\(255, 255, 255, (0?\.\d+)\)/g, (_, a) => INK_A(parseFloat(a)))
        .replace(/rgba\(34, 211, 238, (0?\.\d+)\)/g, (_, a) => ACCENT_A(parseFloat(a)))
        .replace(/#22d3ee\b/gi, 'var(--accent)')
        .replace(/#67e8f9\b/gi, 'color-mix(in srgb, var(--accent), white 20%)')
        .replace(/#06b6d4\b/gi, 'color-mix(in srgb, var(--accent), black 10%)')
        .replace(/#030712\b/gi, 'var(--on-accent)')
        .replace(/#(111827|1c2127)\b/gi, 'var(--screen)')
        .replace(/#1f2937\b/gi, 'var(--bezel-raised)')
        .replace(/#374151\b/gi, 'var(--bezel-raised)')
        .replace(/#424b57\b/gi, isBg ? 'var(--bezel-high)' : 'var(--line-strong)')
        .replace(/#(6b7280|9ca3af)\b/gi, 'var(--ink-3)');
    return v === value ? null : v;
}

// A small brace parser: enough for lara, which nests at most @layer > @media.
function parse(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    function block() {
        const items = [];
        while (i < css.length) {
            const open = css.indexOf('{', i);
            const close = css.indexOf('}', i);
            if (close !== -1 && (open === -1 || close < open)) { i = close + 1; return items; }
            if (open === -1) break;
            const prelude = css.slice(i, open).trim();
            i = open + 1;
            if (prelude.startsWith('@')) {
                if (/^@(font-face|keyframes)/.test(prelude)) { skipBlock(); continue; }
                items.push({ at: prelude, children: block() });
            } else {
                const end = css.indexOf('}', i);
                items.push({ selector: prelude, body: css.slice(i, end) });
                i = end + 1;
            }
        }
        return items;
    }
    function skipBlock() {
        let depth = 1;
        while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    }
    return block();
}

function emit(items, insideLayer, indent) {
    const out = [];
    for (const it of items) {
        if (it.at) {
            const isLayer = it.at.startsWith('@layer');
            const inner = emit(it.children, insideLayer || isLayer, isLayer ? indent : indent + '  ');
            if (!inner.length) continue;
            if (isLayer) out.push(...inner);
            else out.push(`${indent}${it.at} {`, ...inner, `${indent}}`);
            continue;
        }
        if (!insideLayer) continue;
        const selectors = it.selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim())
            .filter((s) => USED.test(s) && !SKIP.test(s));
        if (!selectors.length) continue;
        const decls = [];
        for (const d of it.body.split(';')) {
            const c = d.indexOf(':');
            if (c === -1) continue;
            const prop = d.slice(0, c).trim();
            if (!/^(background|color|border|box-shadow|outline)/.test(prop)) continue;
            const mapped = mapValue(prop, d.slice(c + 1).trim());
            if (mapped) decls.push(`${prop}: ${mapped};`);
        }
        if (!decls.length) continue;
        out.push(`${indent}${selectors.join(',\n' + indent)} { ${decls.join(' ')} }`);
    }
    return out;
}

const body = emit(parse(readFileSync(source, 'utf8')), false, '  ');
const header = `/* GENERATED by scripts/lara-tokens.mjs — do not edit; run \`npm run theme:lara\`.
   lara-dark-cyan's hardcoded colours, re-pointed at the palette tokens, inside
   lara's own layer: it overrides lara and loses to everything in
   theme-monolith.css. See the script for why. */
`;
writeFileSync(target, `${header}@layer primereact {\n${body.join('\n')}\n}\n`);
console.log(`wrote ${target} (${body.length} lines)`);
