import { useRef, useState } from 'react';
import type React from 'react';

/**
 * A main area with a resizable side pane on its right (the `.pod-split`
 * layout): the pod list's detail panel, the resource graph's impact summary.
 * The width is a per-user preference, so it lives in localStorage under
 * `storageKey` and survives restarts; both sides keep at least `minPane`.
 */
export function useSplitPane(storageKey: string, defaultWidth: number, minPane: number) {
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
            next = Math.round(Math.min(Math.max(box.right - ev.clientX, minPane), box.width - minPane));
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
