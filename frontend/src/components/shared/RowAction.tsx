import React from 'react';
import { Button } from 'primereact/button';

/**
 * An icon button in a table row's action cell (Logs, Shell, Edit, …).
 *
 * `label` is required because the button has no visible text: it becomes the
 * accessible name and the hover hint. The views used to hand-write these with
 * neither, so a screen reader announced every row's buttons as "button", and
 * some passed the icon as a child rather than `icon`, which skipped PrimeReact's
 * icon-only class and with it the centring fix in theme-monolith.css.
 */
export default function RowAction({ icon, label, onClick, disabled, loading, severity = 'secondary' }: {
    icon: React.ReactNode;
    label: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    /** Swaps the glyph for a spinner while the action runs. */
    loading?: boolean;
    /** `danger` for a destructive action (delete); the glyph turns red. */
    severity?: 'secondary' | 'danger';
}) {
    return (
        <Button
            icon={icon}
            text
            size="small"
            severity={severity}
            aria-label={label}
            title={label}
            onClick={onClick}
            disabled={disabled}
            loading={loading}
        />
    );
}
