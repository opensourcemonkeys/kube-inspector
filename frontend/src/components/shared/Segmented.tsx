import { useRef } from 'react';

/**
 * A row of keys of which exactly one is down — a mode selector (Pods /
 * Workloads, CPU / Memory). Flat, with the chosen key pressed into the bezel.
 *
 * A radiogroup, so arrow keys move the choice and Tab enters and leaves the
 * group as one stop, the way a native set of radio buttons behaves.
 */
export default function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    ariaLabel: string;
}) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const move = (from: number, step: number) => {
        const next = (from + step + options.length) % options.length;
        onChange(options[next].value);
        refs.current[next]?.focus();
    };
    return (
        <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
            {options.map((o, i) => {
                const on = o.value === value;
                return (
                    <button
                        key={o.value}
                        ref={(el) => { refs.current[i] = el; }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        className={`segmented__opt${on ? ' is-on' : ''}`}
                        onClick={() => onChange(o.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
                            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
                        }}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}
