import { useEffect } from 'react';
import { Button } from 'primereact/button';
import { VscHistory } from 'react-icons/vsc';
import type { models } from '../../../../wailsjs/go/models';
import { useTabContext, type ObjectHistoryDef } from '../../../contexts/TabContext';
import { useT } from '../../../i18n/useT';
import { useToolboxStatus, useToolboxStatusStore } from '../../../stores/toolboxStatusStore';
import RowAction from '../../shared/RowAction';

type TFn = ReturnType<typeof useT>;

/** Why an object's history cannot be opened, or null when it can (or is still being checked). */
export function historyUnavailable(t: TFn, status: models.ToolboxStatus | null): string | null {
    switch (status?.state) {
        case undefined:
        case 'ok':
            return null;
        case 'notInstalled':
            return t('panels:objectHistory.unavailable.notInstalled');
        case 'forbidden':
            return t('panels:objectHistory.unavailable.forbidden');
        default:
            return t('panels:objectHistory.unavailable.unreachable');
    }
}

/**
 * "History" for one object: opens its toolbox timeline. Shown on every
 * cluster, but held off — with the reason on hover — where toolbox is not
 * installed or not reachable with the user's access.
 */
export default function HistoryButton({ def, variant = 'text' }: { def: ObjectHistoryDef; variant?: 'text' | 'icon' }) {
    const t = useT();
    const { openObjectHistory } = useTabContext();
    const status = useToolboxStatus(def.clusterName);
    const ensure = useToolboxStatusStore((s) => s.ensure);
    useEffect(() => { ensure(def.clusterName); }, [def.clusterName, ensure]);

    const reason = historyUnavailable(t, status);
    const open = () => openObjectHistory(def);
    // A disabled button swallows hover, so its reason goes on a wrapper.
    return (
        <span className="history-entry" title={reason ?? undefined}>
            {variant === 'icon' ? (
                <RowAction icon={<VscHistory size={15} />} label={t('panels:objectHistory.open')} disabled={!!reason} onClick={open} />
            ) : (
                <Button label={t('panels:objectHistory.open')} icon={<VscHistory size={16} />} text size="small" disabled={!!reason} onClick={open} />
            )}
        </span>
    );
}
