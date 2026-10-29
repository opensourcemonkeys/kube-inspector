import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { Button } from 'primereact/button';
import { VscTools, VscHistory, VscArrowSwap, VscRefresh, VscLinkExternal } from 'react-icons/vsc';
import { GetToolboxStatus } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import RowAction from '../shared/RowAction';
import RecordingHealth from './RecordingHealth';
import InstallGuide from './InstallGuide';

const STATE_TONE: Record<string, LampTone> = { ok: 'ok', notInstalled: 'idle', forbidden: 'warn', unreachable: 'err' };

/**
 * The tools that run inside a cluster (the toolbox/ Helm chart), one per row.
 *
 * Cluster history inspection needs toolbox installed and the user's access to
 * reach it, so its row says which of those is missing instead of hiding.
 * Cluster migration is a placeholder that is not built yet.
 */
export default function ToolboxPanel({ params, api }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const { clusterName } = params;
    const { openClusterHistory } = useTabContext();
    const [status, setStatus] = useState<models.ToolboxStatus | null>(null);
    const [checking, setChecking] = useState(false);
    // Bumped by Refresh so the health section re-reads too.
    const [refreshKey, setRefreshKey] = useState(0);

    const check = useCallback(async () => {
        setChecking(true);
        try {
            setStatus(await GetToolboxStatus(clusterName));
        } catch (e) {
            setStatus(models.ToolboxStatus.createFrom({ state: 'unreachable', detail: errText(e) }));
        } finally {
            setChecking(false);
        }
    }, [clusterName]);

    useEffect(() => { void check(); }, [check]);

    const state = status?.state ?? '';
    const ready = state === 'ok';
    const stateLabel = (s: string) => {
        switch (s) {
            case 'ok': return t('panels:toolbox.state.ok');
            case 'notInstalled': return t('panels:toolbox.state.notInstalled');
            case 'forbidden': return t('panels:toolbox.state.forbidden');
            default: return t('panels:toolbox.state.unreachable');
        }
    };
    const stateHint = (s: models.ToolboxStatus) => {
        switch (s.state) {
            case 'ok': return t('panels:toolbox.hint.ok', { version: s.version || '?', namespace: s.namespace, service: s.service });
            case 'notInstalled': return t('panels:toolbox.hint.notInstalled');
            case 'forbidden': return t('panels:toolbox.hint.forbidden');
            default: return t('panels:toolbox.hint.unreachable');
        }
    };

    return (
        <div className="tool-panel">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscTools size={14} aria-hidden />
                    {t('panels:toolbox.label')}
                </span>
                <div className="panel-toolbar__actions">
                    <RowAction icon={<VscRefresh size={14} />} label={t('panels:toolbox.refresh')} loading={checking}
                        onClick={() => { void check(); setRefreshKey((n) => n + 1); }} />
                </div>
            </div>

            <p className="tool-panel__intro">{t('panels:toolbox.intro')}</p>

            <ul className="tool-list">
                <li className="tool-row" aria-disabled={!ready}>
                    <span className="tool-row__icon" aria-hidden><VscHistory size={20} /></span>
                    <div className="tool-row__body">
                        <div className="tool-row__title">{t('panels:toolbox.history.title')}</div>
                        <div className="tool-row__desc">{t('panels:toolbox.history.desc')}</div>
                        <div className="tool-row__state">
                            {status === null ? (
                                <StatusLamp label={t('panels:toolbox.checking')} tone="idle" />
                            ) : (
                                <>
                                    <StatusLamp label={stateLabel(state)} tone={STATE_TONE[state] ?? 'err'} />
                                    {/* The API error itself, so a 403 names the
                                        verb and resource the user is missing. */}
                                    <span className="tool-row__hint" title={status.detail || undefined}>{stateHint(status)}</span>
                                </>
                            )}
                        </div>
                        {state === 'notInstalled' && <InstallGuide clusterName={clusterName} />}
                        {ready && <RecordingHealth clusterName={clusterName} refreshKey={refreshKey} />}
                    </div>
                    <Button
                        className="tool-row__action"
                        label={t('panels:toolbox.open')}
                        icon={<VscLinkExternal size={14} />}
                        size="small"
                        severity="secondary"
                        disabled={!ready}
                        onClick={() => openClusterHistory(clusterName, api.id)}
                    />
                </li>

                <li className="tool-row" aria-disabled>
                    <span className="tool-row__icon" aria-hidden><VscArrowSwap size={20} /></span>
                    <div className="tool-row__body">
                        <div className="tool-row__title">{t('panels:toolbox.migration.title')}</div>
                        <div className="tool-row__desc">{t('panels:toolbox.migration.desc')}</div>
                        <div className="tool-row__state">
                            <StatusLamp label={t('panels:toolbox.migration.dev')} tone="idle" />
                        </div>
                    </div>
                    <Button
                        className="tool-row__action"
                        label={t('panels:toolbox.open')}
                        icon={<VscLinkExternal size={14} />}
                        size="small"
                        severity="secondary"
                        disabled
                    />
                </li>
            </ul>
        </div>
    );
}
