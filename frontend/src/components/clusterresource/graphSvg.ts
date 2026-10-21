import { NODE_H, NODE_W } from './graphLayout';
import type { GraphDirection } from '../../stores/resourceGraphStore';

// The resource graph as a standalone SVG file. Drawn from the layout, not
// captured from the screen: reactflow only renders what is in view
// (onlyRenderVisibleElements), so a capture of a large graph would miss most
// of it. Colours arrive resolved — a file cannot read the app's CSS tokens.

export interface SvgBox {
    id: string;
    x: number;
    y: number;
    kind: string;
    name: string;
    sub: string;
    status?: string;
    statusColor?: string;
    /** The fourth line: a problem, an impact, a pod summary. */
    line?: string;
    lineColor?: string;
    kindColor: string;
    /** Removed since it was last seen, or a placeholder for something missing: dashed. */
    dashed?: boolean;
    faded?: boolean;
}

export interface SvgEdge {
    source: string;
    target: string;
    color: string;
    dash?: string;
    width: number;
}

export interface SvgFrame {
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    detail?: string;
}

export interface SvgPalette {
    background: string;
    surface: string;
    border: string;
    frame: string;
    ink: string;
    ink2: string;
    ink3: string;
    font: string;
}

const MARGIN = 24;

const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A box is 220px wide; past this many characters a line would run out of it.
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const round = (n: number) => Math.round(n * 10) / 10;

export function graphToSvg({ boxes, edges, frames, direction, palette, title }: {
    boxes: SvgBox[];
    edges: SvgEdge[];
    frames: SvgFrame[];
    direction: GraphDirection;
    palette: SvgPalette;
    title: string;
}): string {
    const rects = [
        ...boxes.map(b => ({ x: b.x, y: b.y, w: NODE_W, h: NODE_H })),
        ...frames.map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h })),
    ];
    const minX = rects.length ? Math.min(...rects.map(r => r.x)) : 0;
    const minY = rects.length ? Math.min(...rects.map(r => r.y)) : 0;
    const maxX = rects.length ? Math.max(...rects.map(r => r.x + r.w)) : 0;
    const maxY = rects.length ? Math.max(...rects.map(r => r.y + r.h)) : 0;
    const ox = MARGIN - minX;
    const oy = MARGIN - minY;
    const width = round(maxX - minX + 2 * MARGIN);
    const height = round(maxY - minY + 2 * MARGIN);

    // One arrowhead per edge colour.
    const markers = new Map<string, string>();
    const markerFor = (color: string) => {
        if (!markers.has(color)) markers.set(color, `arrow-${markers.size}`);
        return markers.get(color)!;
    };

    const at = new Map(boxes.map(b => [b.id, b]));
    const tb = direction === 'TB';
    const edgeSvg = edges.flatMap(e => {
        const s = at.get(e.source);
        const t = at.get(e.target);
        if (!s || !t) return [];
        let d: string;
        if (tb) {
            const sx = s.x + ox + NODE_W / 2, sy = s.y + oy + NODE_H;
            const tx = t.x + ox + NODE_W / 2, ty = t.y + oy;
            const mid = (sy + ty) / 2;
            d = `M${round(sx)} ${round(sy)} V${round(mid)} H${round(tx)} V${round(ty)}`;
        } else {
            const sx = s.x + ox + NODE_W, sy = s.y + oy + NODE_H / 2;
            const tx = t.x + ox, ty = t.y + oy + NODE_H / 2;
            const mid = (sx + tx) / 2;
            d = `M${round(sx)} ${round(sy)} H${round(mid)} V${round(ty)} H${round(tx)}`;
        }
        const dash = e.dash ? ` stroke-dasharray="${esc(e.dash)}"` : '';
        return [`<path d="${d}" fill="none" stroke="${esc(e.color)}" stroke-width="${e.width}"${dash} marker-end="url(#${markerFor(e.color)})"/>`];
    });

    const frameSvg = frames.map(f => {
        const x = round(f.x + ox), y = round(f.y + oy);
        const detail = f.detail
            ? `<text x="${round(x + f.w - 10)}" y="${round(y + 17)}" font-size="11" text-anchor="end" fill="${esc(palette.ink3)}">${esc(clip(f.detail, 48))}</text>`
            : '';
        return `<g class="frame"><rect x="${x}" y="${y}" width="${round(f.w)}" height="${round(f.h)}" rx="6" fill="${esc(palette.frame)}" stroke="${esc(palette.border)}" stroke-dasharray="4 3"/>`
            + `<text x="${round(x + 10)}" y="${round(y + 17)}" font-size="12" font-weight="600" fill="${esc(palette.ink2)}">${esc(clip(f.title, 40))}</text>${detail}</g>`;
    });

    const boxSvg = boxes.map(b => {
        const x = round(b.x + ox), y = round(b.y + oy);
        const dash = b.dashed ? ' stroke-dasharray="4 3"' : '';
        const opacity = b.faded ? ' opacity="0.6"' : '';
        const status = b.status
            ? `<text x="${NODE_W - 10}" y="18" font-size="11" text-anchor="end" fill="${esc(b.statusColor ?? palette.ink2)}">${esc(clip(b.status, 18))}</text>`
            : '';
        const line = b.line
            ? `<text x="12" y="70" font-size="11" fill="${esc(b.lineColor ?? palette.ink2)}">${esc(clip(b.line, 34))}</text>`
            : '';
        return `<g class="box" transform="translate(${x} ${y})"${opacity}>`
            + `<rect width="${NODE_W}" height="${NODE_H}" rx="4" fill="${esc(palette.surface)}" stroke="${esc(palette.border)}"${dash}/>`
            + `<rect width="3" height="${NODE_H}" fill="${esc(b.kindColor)}"/>`
            + `<text x="12" y="18" font-size="11" font-weight="500" fill="${esc(b.kindColor)}">${esc(b.kind)}</text>${status}`
            + `<text x="12" y="37" font-size="13" font-weight="600" fill="${esc(palette.ink)}">${esc(clip(b.name, 28))}</text>`
            + `<text x="12" y="54" font-size="11.5" fill="${esc(palette.ink2)}">${esc(clip(b.sub, 34))}</text>${line}</g>`;
    });

    const defs = [...markers.entries()].map(([color, id]) =>
        `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${esc(color)}"/></marker>`);

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(palette.font)}">`,
        `<title>${esc(title)}</title>`,
        `<defs>${defs.join('')}</defs>`,
        `<rect width="100%" height="100%" fill="${esc(palette.background)}"/>`,
        ...frameSvg,
        ...edgeSvg,
        ...boxSvg,
        '</svg>',
        '',
    ].join('\n');
}
