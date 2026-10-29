import { useEffect, useState } from 'react';
import { DryRunToolboxRollback, RollbackToolboxChange } from '../../../../wailsjs/go/controller_app/App';
import { errText } from '../../../lib/errText';
import { useT } from '../../../i18n/useT';
import ConfirmActionDialog from '../../shared/ConfirmActionDialog';
import StatusLamp from '../../shared/StatusLamp';

/** The field manager a rollback writes with (services.fieldManager). */
export const ROLLBACK_FIELD_MANAGER = 'kube-inspector';

type Check = { state: 'running' } | { state: 'ok' } | { state: 'failed'; reason: string };

/**
 * The confirmation for writing one side of a recorded change back. Opening it
 * asks the API server for a dry run of exactly that write, and the confirm
 * button stays off until the dry run has passed: a webhook, a quota or a
 * namespace that is gone answers here instead of after the click.
 */
export default function RollbackDialog({ visible, clusterName, eventId, side, header, message, onHide, onDone }: {
    visible: boolean;
    clusterName: string;
    eventId: string;
    side: 'before' | 'after';
    header: string;
    message: string;
    onHide: () => void;
    /** Called with the backend's result line and when the write was made. */
    onDone: (result: string, at: number) => void;
}) {
    const t = useT();
    const [check, setCheck] = useState<Check>({ state: 'running' });

    useEffect(() => {
        if (!visible) return;
        let stale = false;
        setCheck({ state: 'running' });
        DryRunToolboxRollback(clusterName, eventId, side)
            .then(() => { if (!stale) setCheck({ state: 'ok' }); })
            .catch((e) => { if (!stale) setCheck({ state: 'failed', reason: errText(e) }); });
        return () => { stale = true; };
    }, [visible, clusterName, eventId, side]);

    const extra = check.state === 'running' ? (
        <p className="dlg-note"><StatusLamp label={t('panels:clusterHistory.rollback.dryRun.running')} tone="idle" /></p>
    ) : check.state === 'ok' ? (
        <p className="dlg-note"><StatusLamp label={t('panels:clusterHistory.rollback.dryRun.ok')} tone="ok" /></p>
    ) : (
        <div className="dlg-note">
            <StatusLamp label={t('panels:clusterHistory.rollback.dryRun.failed')} tone="err" />
            <p className="dlg-error">{check.reason}</p>
        </div>
    );

    return (
        <ConfirmActionDialog
            visible={visible}
            header={header}
            message={message}
            extra={extra}
            warning={t('panels:clusterHistory.rollback.warning')}
            confirmLabel={t('panels:clusterHistory.rollback.confirm')}
            severity="danger"
            confirmDisabled={check.state !== 'ok'}
            onHide={onHide}
            onConfirm={async () => {
                const at = Date.now();
                const out = await RollbackToolboxChange(clusterName, eventId, side);
                onDone(out, at);
            }}
        />
    );
}
