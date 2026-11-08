import { useCallback, useRef, useState, type ComponentType } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { VscTools, VscRefresh } from 'react-icons/vsc';
import { useT } from '../../i18n/useT';
import RowAction from '../shared/RowAction';
import BetaTag from './BetaTag';
import HistoryToolRow from './HistoryToolRow';
import MigrationToolRow from './MigrationToolRow';

export interface ToolRowProps {
    clusterName: string;
    panelId: string;
    /** Bumped by Refresh. */
    refreshKey: number;
    /** A row reports a check it has running, for the Refresh button's spinner. */
    onChecking: (busy: boolean) => void;
}

/** The tools, one row each. A row knows what its tool needs and says what is missing. */
const TOOL_ROWS: ComponentType<ToolRowProps>[] = [HistoryToolRow, MigrationToolRow];

export default function ToolboxPanel({ params, api }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const { clusterName } = params;
    const [refreshKey, setRefreshKey] = useState(0);
    const [checking, setChecking] = useState(false);
    const running = useRef(0);
    const onChecking = useCallback((busy: boolean) => {
        running.current += busy ? 1 : -1;
        setChecking(running.current > 0);
    }, []);

    return (
        <div className="tool-panel">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscTools size={14} aria-hidden />
                    {t('panels:toolbox.label')}
                    <BetaTag />
                </span>
                <div className="panel-toolbar__actions">
                    <RowAction icon={<VscRefresh size={14} />} label={t('panels:toolbox.refresh')} loading={checking}
                        onClick={() => setRefreshKey((n) => n + 1)} />
                </div>
            </div>

            <p className="tool-panel__intro">{t('panels:toolbox.intro')}</p>
            <p className="tool-panel__note">{t('panels:toolbox.betaNote')}</p>

            <ul className="tool-list">
                {TOOL_ROWS.map((Row, i) => (
                    <Row key={i} clusterName={clusterName} panelId={api.id} refreshKey={refreshKey} onChecking={onChecking} />
                ))}
            </ul>
        </div>
    );
}
