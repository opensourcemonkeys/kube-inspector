import { useEffect, useRef } from 'react';
import type { Chart as ChartJS, ChartData, ChartOptions, ChartType } from 'chart.js';

// A chart.js canvas for data that refreshes on a poll.
//
// PrimeReact's `Chart` runs an effect with no dependency list that destroys
// and rebuilds the chart.js instance on *every* render — and it rebuilds it
// behind an async `import('chart.js/auto')`, so for a frame or two the canvas
// is empty. A dashboard that re-renders several times per poll therefore
// blinks every chart on each refresh. This component builds the instance once
// and afterwards only swaps `data`/`options` and calls `update('none')`.
//
// chart.js is still loaded lazily (same as PrimeReact) so the module costs
// nothing to the chunks that import it for the formatting helpers alone.
export function LiveChart<T extends ChartType>({ type, data, options, height }: {
    type: T;
    data: ChartData<T, any, any>;
    options?: ChartOptions<T>;
    height: number | string;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<ChartJS | null>(null);
    // The instance is created asynchronously; it must start from the props of
    // the render it lands after, not the render that requested it.
    const latest = useRef({ data, options });
    latest.current = { data, options };

    useEffect(() => {
        let cancelled = false;
        import('chart.js/auto').then(({ default: Chart }) => {
            if (cancelled || !canvasRef.current) return;
            chartRef.current = new Chart(canvasRef.current, { type, ...latest.current } as any);
        });
        return () => {
            cancelled = true;
            chartRef.current?.destroy();
            chartRef.current = null;
        };
    }, [type]);

    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.data = data as any;
        chart.options = (options ?? {}) as any;
        chart.update('none');
    }, [data, options]);

    return (
        <div style={{ position: 'relative', height }}>
            <canvas ref={canvasRef} />
        </div>
    );
}
