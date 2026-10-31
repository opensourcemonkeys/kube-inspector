import { useRef, useState } from 'react';
import { VscShield } from 'react-icons/vsc';
import { Toast } from 'primereact/toast';
import { Message } from 'primereact/message';
import { TabView, TabPanel } from 'primereact/tabview';
import { useT } from '../../../i18n/useT';
import { useTrivyState, useTrivyStore, type TrivySection } from '../../../stores/trivyStore';
import ErrorBanner from '../../shared/ErrorBanner';
import Segmented from '../../shared/Segmented';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import { useClusterScan, type PushToast, type ScanEnd } from './useClusterScan';
import { useScanView } from './useScanView';
import ScanToolbar from './ScanToolbar';
import SummaryView from './SummaryView';
import FixPlanView from './FixPlanView';
import FindingsView from './FindingsView';
import CoverageView from './CoverageView';
import AcceptRiskDialog, { type AcceptRequest } from './AcceptRiskDialog';
import ImageScanTab, { useImageScanner } from './ImageScanTab';

const SECTIONS: TrivySection[] = ['summary', 'fixplan', 'findings', 'coverage'];

export default function TrivyScanner({ clusterName }: { clusterName: string }) {
    const t = useT();
    const toast = useRef<Toast | null>(null);
    const pushToast: PushToast = (severity, summary, detail) =>
        toast.current?.show({ severity, summary, detail, life: 4000 });

    // Everything that must survive switching the top-level tabs lives here:
    // PrimeReact's TabView unmounts the inactive panel, which would otherwise
    // drop the scan subscription and the loaded view.
    const section = useTrivyState(clusterName).section;
    const patch = useTrivyStore((s) => s.patch);
    const data = useScanView(clusterName);
    const onEnd = (end: ScanEnd) => {
        if (end.kind === 'done') void data.showFinished(end.id, end.late);
    };
    const scan = useClusterScan(clusterName, pushToast, onEnd);
    const imageScanner = useImageScanner(clusterName, pushToast);
    const [onlyNew, setOnlyNew] = useState(false);
    const [accepting, setAccepting] = useState<AcceptRequest | null>(null);

    const setSection = (s: TrivySection) => patch(clusterName, { section: s });
    const showNewFindings = () => { setOnlyNew(true); setSection('findings'); };
    const onAccepted = (count: number) => {
        pushToast('success', t('panels:trivy.toastAccepted', { count }));
        data.reload();
    };
    const view = data.view;

    const body = () => {
        if (!view) {
            if (data.scans == null || (data.loading && data.scanId)) return <ListSkeleton rows={6} />;
            if (data.error) return <ErrorBanner block message={data.error} cluster={clusterName} />;
            return <p className="trivy-empty">{t('panels:trivy.noScans')}</p>;
        }
        switch (section) {
            case 'fixplan':
                return <FixPlanView clusterName={clusterName} view={view} onAccept={setAccepting} />;
            case 'findings':
                return <FindingsView view={view} onlyNew={onlyNew} setOnlyNew={setOnlyNew} onAccept={setAccepting} />;
            case 'coverage':
                return <CoverageView clusterName={clusterName} view={view} onChanged={data.reload} pushToast={pushToast} />;
            default:
                return <SummaryView clusterName={clusterName} view={view}
                    onShowNew={showNewFindings} />;
        }
    };

    return (
        <div className="trivy-root">
            <Toast ref={toast} />

            <div className="mon-header">
                <VscShield /> <span>{t('panels:trivy.title')}</span>
                {clusterName && <span className="mon-cluster">{clusterName}</span>}
            </div>

            <TabView className="trivy-tabs">
                <TabPanel header={t('panels:trivy.tab.cluster')}>
                    <div className="trivy-cluster">
                        <ScanToolbar scan={scan} scans={data.scans ?? []} scanId={data.scanId} compareId={data.compareId}
                            onSelect={data.select} onCompare={data.compare} />
                        {scan.error && <ErrorBanner message={scan.error} context={t('panels:trivy.toastK8sFailed')} />}
                        {data.notice && <Message severity="info" text={t('panels:trivy.scanEnded')} />}
                        {view && data.error && <ErrorBanner message={data.error} stale />}
                        {view && (
                            <Segmented<TrivySection> value={section} onChange={setSection} ariaLabel={t('panels:trivy.sectionsAria')}
                                options={SECTIONS.map((s) => ({ value: s, label: t(`panels:trivy.section.${s}`) }))} />
                        )}
                        {body()}
                    </div>
                </TabPanel>
                <TabPanel header={t('panels:trivy.tab.image')}>
                    <ImageScanTab clusterName={clusterName} scanner={imageScanner} pushToast={pushToast} />
                </TabPanel>
            </TabView>

            <AcceptRiskDialog clusterName={clusterName} request={accepting} onHide={() => setAccepting(null)} onSaved={onAccepted} />
        </div>
    );
}
