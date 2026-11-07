import { useId } from 'react';
import { Checkbox } from 'primereact/checkbox';
import type { DeleteFlags } from '../../lib/useResourceList';
import { useT } from '../../i18n/useT';

/**
 * The two `kubectl delete pod` switches, shared by the pod list's delete dialog
 * and the pod detail panel's. Both start unticked; what each one sends is
 * decided in Go (`services.podDeleteOptions`).
 */
export default function PodDeleteOptions({
    value,
    onChange,
    disabled,
}: {
    value: DeleteFlags;
    onChange: (flags: DeleteFlags) => void;
    disabled?: boolean;
}) {
    const t = useT();
    // Several pod panels can have a dialog open at once, so the ids must not repeat.
    const id = useId();
    const options = [
        { key: 'force', label: t('resources:delete.options.force'), hint: t('resources:delete.options.forceHint') },
        { key: 'gracePeriodZero', label: t('resources:delete.options.gracePeriodZero'), hint: t('resources:delete.options.gracePeriodZeroHint') },
    ];

    return (
        <div className="pod-delete-options">
            {options.map((o) => (
                <div key={o.key} className="pod-delete-options__item">
                    <Checkbox
                        inputId={`${id}-${o.key}`}
                        checked={!!value[o.key]}
                        disabled={disabled}
                        onChange={(e) => onChange({ ...value, [o.key]: !!e.checked })}
                    />
                    <label htmlFor={`${id}-${o.key}`}>
                        <span className="pod-delete-options__label">{o.label}</span>
                        <span className="dlg-note">{o.hint}</span>
                    </label>
                </div>
            ))}
        </div>
    );
}
