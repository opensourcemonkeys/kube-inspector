import { useEffect, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { TabView, TabPanel } from 'primereact/tabview';
import { models } from '../../../wailsjs/go/models';
import { GetDiagnostics } from '../../../wailsjs/go/controller_app/App';
import { usePanelActive } from '../../lib/usePanelActive';
import { useDiagnosticsStore } from '../../stores/diagnosticsStore';
import OverviewTab from './OverviewTab';
import LogsTab from './LogsTab';
import ExportTab from './ExportTab';
import { useT } from '../../i18n/useT';
import { VscDesktopDownload, VscInfo, VscListFlat } from 'react-icons/vsc';

/**
 * The Diagnostics panel.
 *
 * Unlike every other view panel this one is a singleton and carries no
 * clusterName: it describes the running process, not a cluster. Its params stay
 * empty so it survives a structured-clone trip to another window.
 */
export default function DiagnosticsPanel({ api }: IDockviewPanelProps) {
    const t = useT();
    const active = usePanelActive(api);
    const { activeTab, setActiveTab } = useDiagnosticsStore();
    const [report, setReport] = useState<models.DiagnosticsReport | null>(null);

    useEffect(() => {
        GetDiagnostics().then(setReport).catch(() => { /* tabs still render */ });
    }, []);

    return (
        <div className="diag-panel">
            <TabView activeIndex={activeTab} onTabChange={(e) => setActiveTab(e.index)}>
                <TabPanel header={t('panels:diagnostics.tab.overview')} leftIcon={<VscInfo className="tab-icon" aria-hidden />}>
                    <OverviewTab report={report} onReport={setReport} />
                </TabPanel>
                <TabPanel header={t('panels:diagnostics.tab.logs')} leftIcon={<VscListFlat className="tab-icon" aria-hidden />}>
                    {/* Poll only while this tab is both the active Dockview panel
                        and the selected TabView tab. */}
                    <LogsTab active={active && activeTab === 1} ownPid={report?.pid ?? 0} />
                </TabPanel>
                <TabPanel header={t('panels:diagnostics.tab.export')} leftIcon={<VscDesktopDownload className="tab-icon" aria-hidden />}>
                    <ExportTab report={report} />
                </TabPanel>
            </TabView>
        </div>
    );
}
