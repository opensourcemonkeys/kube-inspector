import { useRef, useState } from 'react';
import type React from 'react';

/**
 * A main area with a resizable side pane on its right (the `.pod-split`
 * layout): the pod list's detail panel, the resource graph's impact summary.
 * The width is a per-user preference, so it lives in localStorage under
 * `storageKey` and survives restarts; both sides keep at least `minPane`.
 *
 * With `axis: 'y'` the pane is below the main area instead and `width` is
 * its height (the object history's diff under its timeline). With
 * `from: 'start'` the sized pane is the one on the left (or top) instead —
 * the ConfigMap/Secret editor's key list.
 */
export function useSplitPane(storageKey: string, defaultWidth: number, minPane: number, axis: 'x' | 'y' = 'x', from: 'start' | 'end' = 'end') {
    const splitRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState<number>(() => {
        try {
            const saved = Number(localStorage.getItem(storageKey));
            if (saved > 0) return saved;
        } catch { /* storage unavailable */ }
        return defaultWidth;
    });

    const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
        const box = splitRef.current?.getBoundingClientRect();
        if (!box) return;
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        let next = width;
        const move = (ev: PointerEvent) => {
            const [near, far, pos, span] = axis === 'x'
                ? [box.left, box.right, ev.clientX, box.width]
                : [box.top, box.bottom, ev.clientY, box.height];
            const size = from === 'end' ? far - pos : pos - near;
            next = Math.round(Math.min(Math.max(size, minPane), span - minPane));
            setWidth(next);
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            try { localStorage.setItem(storageKey, String(next)); } catch { /* storage unavailable */ }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    };

    return { splitRef, width, startResize };
}
