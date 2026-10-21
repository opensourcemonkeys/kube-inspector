import { describe, expect, it } from 'vitest';
import { graphToSvg, type SvgBox, type SvgPalette } from './graphSvg';

const palette: SvgPalette = {
    background: '#111', surface: '#222', border: '#444', frame: '#1a1a1a',
    ink: '#eee', ink2: '#bbb', ink3: '#888', font: 'IBM Plex Sans, sans-serif',
};

const box = (id: string, x: number, y: number, extra: Partial<SvgBox> = {}): SvgBox =>
    ({ id, x, y, kind: 'Pod', name: id, sub: 'default', kindColor: '#5be', ...extra });

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('graphToSvg', () => {
    const svg = graphToSvg({
        boxes: [
            box('a', 0, 0, { kind: 'Deployment', name: 'web <prod> & "co"', status: '2/2', statusColor: '#0f0' }),
            box('b', 0, 200, { line: 'Event: BackOff ×3', lineColor: '#f80', dashed: true, faded: true }),
            box('c', 300, 200),
        ],
        edges: [
            { source: 'a', target: 'b', color: '#999', width: 1.5 },
            { source: 'a', target: 'c', color: '#999', dash: '6 3', width: 1.5 },
            { source: 'a', target: 'gone', color: '#f00', width: 2 },
        ],
        frames: [{ x: -20, y: -50, w: 600, h: 400, title: 'namespace & co', detail: '3 objects' }],
        direction: 'TB',
        palette,
        title: 'Resource graph · c1',
    });
    const doc = parse(svg);

    it('is well-formed XML with every box, edge to a drawn box, and frame', () => {
        expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
        expect(doc.querySelectorAll('g.box')).toHaveLength(3);
        expect(doc.querySelectorAll('path[marker-end]')).toHaveLength(2);
        expect(doc.querySelectorAll('g.frame')).toHaveLength(1);
    });

    it('escapes what the cluster names things', () => {
        expect(svg).toContain('web &lt;prod&gt; &amp; &quot;co&quot;');
        expect(doc.querySelector('g.box text:nth-of-type(3)')?.textContent).toBe('web <prod> & "co"');
    });

    it('shares one arrowhead per colour and sizes the canvas to fit, frames included', () => {
        expect(doc.querySelectorAll('marker')).toHaveLength(1);
        const root = doc.documentElement;
        expect(root.getAttribute('width')).toBe(String(600 + 48));
        expect(root.getAttribute('height')).toBe(String(400 + 48));
    });

    it('routes a top-down edge from the bottom of the source to the top of the target', () => {
        const d = doc.querySelector('path[marker-end]')!.getAttribute('d')!;
        // Frame at (-20,-50) shifts everything by (44, 74): source bottom-centre, target top-centre.
        expect(d).toBe('M154 154 V214 H154 V274');
    });

    it('marks a removed object dashed and faded', () => {
        const b = doc.querySelectorAll('g.box')[1];
        expect(b.getAttribute('opacity')).toBe('0.6');
        expect(b.querySelector('rect')!.getAttribute('stroke-dasharray')).toBe('4 3');
    });
});
