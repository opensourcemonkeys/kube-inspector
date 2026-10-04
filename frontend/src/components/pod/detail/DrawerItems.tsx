import { useState, type ReactNode } from 'react';
import { useT } from '../../../i18n/useT';

/** One label/value row of the detail list. */
export function Item({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="pd-item">
            <div className="pd-item__label">{label}</div>
            <div className="pd-item__value">{children}</div>
        </div>
    );
}

/** A section title bar, like Lens' "Init Containers". */
export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="pd-section">
            <h4 className="pd-section__title">{title}</h4>
            {children}
        </section>
    );
}

/** key=value badges. Long values (annotations) truncate; click one to see it whole. */
export function Badges({ entries }: { entries: [string, string][] }) {
    const [open, setOpen] = useState<string | null>(null);
    return (
        <div className="pd-badges">
            {entries.map(([k, v]) => {
                const text = `${k}=${v}`;
                return (
                    <button key={k} type="button" title={text} onClick={() => setOpen(open === k ? null : k)}
                        className={`pd-badge${open === k ? ' pd-badge--open' : ''}`}>
                        {text}
                    </button>
                );
            })}
        </div>
    );
}

/** A count with a Show/Hide toggle that reveals the full content underneath. */
export function Expandable({ count, children }: { count: number; children: ReactNode }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    return (
        <div className="pd-expand">
            <div className="pd-expand__head">
                <span>{count}</span>
                <button type="button" className="pd-expand__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
                    {open ? t('resources:pod.detail.hide') : t('resources:pod.detail.show')}
                    <span className={`pd-expand__caret${open ? ' pd-expand__caret--open' : ''}`} aria-hidden />
                </button>
            </div>
            {open && <div className="pd-expand__body">{children}</div>}
        </div>
    );
}

export const Muted = ({ children }: { children: ReactNode }) => <span className="pd-muted">{children}</span>;
