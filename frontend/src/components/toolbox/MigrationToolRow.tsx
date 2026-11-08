import { Button } from 'primereact/button';
import { VscArrowSwap, VscLinkExternal } from 'react-icons/vsc';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useTabContext } from '../../contexts/TabContext';
import { useT } from '../../i18n/useT';
import StatusLamp from '../shared/StatusLamp';
import type { ToolRowProps } from './ToolboxPanel';

/**
 * Cluster Migration installs nothing, so what it needs is not the chart but a
 * second cluster to migrate to.
 */
export default function MigrationToolRow({ clusterName, panelId }: ToolRowProps) {
    const t = useT();
    const { clusters } = useClusterContext();
    const { openMigration } = useTabContext();
    const ready = clusters.some((c) => c !== clusterName);
    return (
        <li className="tool-row" aria-disabled={!ready}>
            <span className="tool-row__icon" aria-hidden><VscArrowSwap size={20} /></span>
            <div className="tool-row__body">
                <div className="tool-row__title">{t('panels:toolbox.migration.title')}</div>
                <div className="tool-row__desc">{t('panels:toolbox.migration.desc')}</div>
                <div className="tool-row__state">
                    <StatusLamp label={ready ? t('panels:toolbox.migration.ready') : t('panels:toolbox.migration.noTargetState')} tone={ready ? 'ok' : 'idle'} />
                    <span className="tool-row__hint">{ready ? t('panels:toolbox.migration.hint') : t('panels:toolbox.migration.noTarget')}</span>
                </div>
            </div>
            <Button className="tool-row__action" label={t('panels:toolbox.open')} icon={<VscLinkExternal size={14} />} size="small" severity="secondary"
                disabled={!ready} onClick={() => openMigration(clusterName, panelId)} />
        </li>
    );
}
