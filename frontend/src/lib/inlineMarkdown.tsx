import { Fragment, type ReactNode } from 'react';

/**
 * The inline Markdown subset CHANGELOG.md uses — **bold**, *italic*, `code`
 * and [links](https://…) — parsed into a small tree and rendered as React
 * elements. There is deliberately no HTML path (no innerHTML, no raw tags):
 * this renders text fetched from the network, and a renderer that cannot
 * produce markup cannot be made to inject any. Anything it does not recognise,
 * an unclosed `**` included, stays literal text.
 */
export type InlineNode =
    | string
    | { kind: 'code'; text: string }
    | { kind: 'strong' | 'em'; children: InlineNode[] }
    | { kind: 'link'; href: string; children: InlineNode[] };

// Tried at every position; the earliest match wins, ties in this order (code
// first, so `**` inside backticks stays literal).
const PATTERNS: { kind: 'code' | 'link' | 'strong' | 'em'; re: RegExp }[] = [
    { kind: 'code', re: /`([^`]+)`/ },
    { kind: 'link', re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
    { kind: 'strong', re: /\*\*(.+?)\*\*/ },
    { kind: 'em', re: /\*([^*\s][^*]*?)\*/ },
];

export function parseInline(src: string): InlineNode[] {
    const out: InlineNode[] = [];
    let rest = src;
    while (rest) {
        let best: { kind: (typeof PATTERNS)[number]['kind']; m: RegExpExecArray } | null = null;
        for (const p of PATTERNS) {
            const m = p.re.exec(rest);
            if (m && (!best || m.index < best.m.index)) best = { kind: p.kind, m };
        }
        if (!best) {
            out.push(rest);
            break;
        }
        const { kind, m } = best;
        if (m.index > 0) out.push(rest.slice(0, m.index));
        if (kind === 'code') out.push({ kind, text: m[1] });
        else if (kind === 'link') out.push({ kind, href: m[2], children: parseInline(m[1]) });
        else out.push({ kind, children: parseInline(m[1]) });
        rest = rest.slice(m.index + m[0].length);
    }
    return out;
}

/** Only web links open; anything else (javascript:, file:, relative) renders as its text. */
const isWebLink = (href: string) => /^https?:\/\//i.test(href);

export function renderInline(nodes: InlineNode[], onLink: (href: string) => void): ReactNode {
    return nodes.map((n, i) => {
        if (typeof n === 'string') return <Fragment key={i}>{n}</Fragment>;
        switch (n.kind) {
            case 'code': return <code key={i}>{n.text}</code>;
            case 'strong': return <strong key={i}>{renderInline(n.children, onLink)}</strong>;
            case 'em': return <em key={i}>{renderInline(n.children, onLink)}</em>;
            case 'link':
                return isWebLink(n.href)
                    ? <a key={i} href={n.href} onClick={(e) => { e.preventDefault(); onLink(n.href); }}>{renderInline(n.children, onLink)}</a>
                    : <Fragment key={i}>{renderInline(n.children, onLink)}</Fragment>;
        }
    });
}

/** Parses and renders one line of inline Markdown. */
export function InlineMarkdown({ text, onLink }: { text: string; onLink: (href: string) => void }) {
    return <>{renderInline(parseInline(text), onLink)}</>;
}
