import { useEffect, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputNumber } from 'primereact/inputnumber';
import { Slider } from 'primereact/slider';
import { VscClose, VscCheck } from 'react-icons/vsc';
import { ScaleWorkload, GetWorkloadAutoscaler } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';

/**
 * Replica-count dialog for Deployments, StatefulSets and ReplicaSets.
 *
 * The current count comes from the list row, which already carries `replicas`
 * — no extra API call to open the dialog.
 */
export default function ScaleDialog({
    visible,
    clusterName,
    kind,
    name,
    namespace,
    currentReplicas,
    onHide,
    onDone,
}: {
    visible: boolean;
    clusterName: string;
    /** Singular lowercase kind, matching the backend's vocabulary. */
    kind: 'deployment' | 'statefulset' | 'replicaset';
    name: string;
    namespace: string;
    currentReplicas: number;
    onHide: () => void;
    onDone: (replicas: number) => void;
}) {
    const t = useT();
    const [replicas, setReplicas] = useState<number>(currentReplicas);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hpa, setHpa] = useState<models.HPAInfo | null>(null);

    // Replica counts have no natural upper bound, but a slider needs one. The
    // ceiling is therefore *latched state*, not a derived value: it is seeded
    // from the current count when the dialog opens and only ever grows (when an
    // HPA reveals a higher max, or when the user types past it). Deriving it
    // from `replicas` instead would make it shrink while dragging the handle
    // left, and the handle would jump back to the far right under the cursor.
    const [sliderMax, setSliderMax] = useState(10);

    // Reset to the row's live value every time the dialog opens: the same
    // component instance is reused across openings, so stale state from the
    // previous target would otherwise be pre-filled.
    useEffect(() => {
        if (!visible) return;
        setReplicas(currentReplicas);
        setError(null);
        setHpa(null);
        setSliderMax(Math.max(10, currentReplicas * 2));
    }, [visible, currentReplicas]);

    useEffect(() => {
        if (hpa) setSliderMax((max) => Math.max(max, hpa.max_replicas));
    }, [hpa]);

    // Keeps the handle reachable when a value above the ceiling is typed in.
    const setReplicaCount = (value: number) => {
        setReplicas(value);
        setSliderMax((max) => Math.max(max, value));
    };

    // The backend returns null both when no HPA targets this workload and when
    // it could not find out (no RBAC verb, or a pre-1.23 cluster). Both mean
    // "no warning to show" — never a reason to block the scale.
    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        GetWorkloadAutoscaler(clusterName, kind, name, namespace)
            .then((found) => {
                if (!cancelled) setHpa(found ?? null);
            })
            .catch(() => {
                if (!cancelled) setHpa(null);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, clusterName, kind, name, namespace]);

    const close = () => {
        if (busy) return;
        onHide();
    };

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await ScaleWorkload(clusterName, kind, name, namespace, replicas);
            onDone(replicas);
            onHide();
        } catch (e) {
            setError(errText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            header={t('panels:scale.title', { kind })}
            visible={visible}
            className="scale-dialog"
            modal
            onHide={close}
            footer={
                <div className="dlg-actions">
                    <Button label={t('action.cancel')} icon={<VscClose size={16} />} text onClick={close} disabled={busy} />
                    <Button
                        label={t('panels:scale.confirm')}
                        icon={<VscCheck size={16} />}
                        onClick={submit}
                        loading={busy}
                        disabled={replicas == null || replicas < 0}
                    />
                </div>
            }
        >
            <div className="dlg-form">
                <p className="dlg-subject">{namespace}/{name}</p>

                {/* Slider for the common case (a handful of replicas), number
                    input for exact or large values the slider cannot reach. */}
                <div className="dlg-field">
                    <label htmlFor="scale-replicas" className="dlg-label">
                        {t('panels:scale.replicas')}{' '}
                        <span className="dlg-label__hint">{t('panels:scale.currently', { count: currentReplicas })}</span>
                    </label>
                    <div className="scale-dialog__row">
                        <Slider
                            value={replicas}
                            min={0}
                            max={sliderMax}
                            onChange={(e) => setReplicaCount(typeof e.value === 'number' ? e.value : e.value[0])}
                            aria-label={t('panels:scale.replicas')}
                        />
                        <InputNumber
                            inputId="scale-replicas"
                            value={replicas}
                            min={0}
                            autoFocus
                            onValueChange={(e) => setReplicaCount(e.value ?? 0)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !busy) submit();
                            }}
                        />
                    </div>
                    <div className="scale-dialog__ends">
                        <span>0</span>
                        <span>{sliderMax}</span>
                    </div>
                </div>

                {hpa && (
                    <p className="dlg-note dlg-note--warn">
                        {t('panels:scale.hpaWarning', {
                            name: hpa.name,
                            min: hpa.min_replicas,
                            max: hpa.max_replicas,
                        })}
                    </p>
                )}

                {replicas === 0 && (
                    <p className="dlg-note dlg-note--warn">{t('panels:scale.zeroWarning')}</p>
                )}

                {error && <p className="dlg-error">{error}</p>}
            </div>
        </Dialog>
    );
}
