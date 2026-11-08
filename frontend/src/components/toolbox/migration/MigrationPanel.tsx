import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { VscArrowSwap } from 'react-icons/vsc';
import { MigrationGetRunning } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import BetaTag from '../BetaTag';
import MigrationPreflightView from './MigrationPreflightView';
import MigrationProgressView from './MigrationProgressView';
import MigrationResultView from './MigrationResultView';
import MigrationSetup from './MigrationSetup';

type View =
    | { name: 'loading' }
    | { name: 'setup' }
    | { name: 'preflight'; request: models.MigrationRequest }
    | { name: 'progress'; id: string }
    | { name: 'result'; id: string };

/**
 * Cluster Migration, opened from the Toolbox tab and pinned to the source
 * cluster. Which step it shows is local; what is really happening lives in the
 * backend, which this asks again whenever the panel opens.
 */
export default function MigrationPanel({ params, api }: IDockviewPanelProps<{ clusterName: string }>) {
    const t = useT();
    const source = params.clusterName;
    const [view, setView] = useState<View>({ name: 'loading' });
    const [draft, setDraft] = useState<models.MigrationRequest | null>(null);

    useEffect(() => {
        let stale = false;
        MigrationGetRunning(source)
            .then((running) => { if (!stale) setView(running ? { name: 'progress', id: running.id } : { name: 'setup' }); })
            .catch(() => { if (!stale) setView({ name: 'setup' }); });
        return () => { stale = true; };
    }, [source]);

    const progressId = view.name === 'progress' ? view.id : '';
    const finished = useCallback(() => setView({ name: 'result', id: progressId }), [progressId]);

    return (
        <div className="tool-panel">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label">
                    <VscArrowSwap size={14} aria-hidden />
                    {t('panels:toolbox.migration.title')}
                    <BetaTag />
                </span>
            </div>
            {view.name === 'loading' && <div className="mig-body"><ListSkeleton /></div>}
            {view.name === 'setup' && (
                <MigrationSetup source={source} draft={draft}
                    onCheck={(request) => { setDraft(request); setView({ name: 'preflight', request }); }}
                    onOpen={(id) => setView({ name: 'result', id })} />
            )}
            {view.name === 'preflight' && (
                <MigrationPreflightView request={view.request}
                    onBack={() => setView({ name: 'setup' })}
                    onStarted={(id) => setView({ name: 'progress', id })} />
            )}
            {view.name === 'progress' && <MigrationProgressView id={view.id} source={source} onFinished={finished} />}
            {view.name === 'result' && <MigrationResultView id={view.id} api={api} onNew={() => setView({ name: 'setup' })} />}
        </div>
    );
}
