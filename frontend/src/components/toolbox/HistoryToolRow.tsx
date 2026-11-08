import { useCallback, useEffect, useState } from 'react';
import { Button } from 'primereact/button';
import { VscHistory, VscLinkExternal } from 'react-icons/vsc';
import { GetToolboxStatus } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import RecordingHealth from './RecordingHealth';
import InstallGuide from './InstallGuide';
import type { ToolRowProps } from './ToolboxPanel';

const STATE_TONE: Record<string, LampTone> = { ok: 'ok', notInstalled: 'idle', forbidden: 'warn', unreachable: 'err' };

/**
 * Cluster history needs the change recorder installed and the user's access to
 * reach it, so this row says which of those is missing instead of hiding.
 */
export default function HistoryToolRow({ clusterName, panelId, refreshKey, onChecking }: ToolRowProps) {
    const t = useT();
    const { openClusterHistory } = useTabContext();
    const [status, setStatus] = useState<models.ToolboxStatus | null>(null);

    const check = useCallback(async () => {
        onChecking(true);
        try {
            setStatus(await GetToolboxStatus(clusterName));
        } catch (e) {
            setStatus(models.ToolboxStatus.createFrom({ state: 'unreachable', detail: errText(e) }));
        } finally {
            onChecking(false);
        }
    }, [clusterName, onChecking]);

    useEffect(() => { void check(); }, [check, refreshKey]);

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
            <Button className="tool-row__action" label={t('panels:toolbox.open')} icon={<VscLinkExternal size={14} />} size="small" severity="secondary"
                disabled={!ready} onClick={() => openClusterHistory(clusterName, panelId)} />
        </li>
    );
}
