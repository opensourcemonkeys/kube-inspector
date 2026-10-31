import { useMemo, useState } from 'react';
import { VscPlay, VscExport } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { InputText } from 'primereact/inputtext';
import { ProgressBar } from 'primereact/progressbar';
import { TrivyScanImage, TrivyExportImageReport } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { errText } from '../../../lib/errText';
import { SEVERITIES, SeverityTag } from './severity';
import { reportLabels } from './trivyModel';
import FindingDetailDialog, { DetailFinding, vulnToFinding } from './FindingDetailDialog';
import { VulnTable } from './findingTables';
import type { PushToast } from './useClusterScan';

type Progress = { current: number; total: number; image: string } | null;

const NO_WORKLOAD = { kind: '', name: '', namespace: '' };

/** One table row per vulnerability of a single-image scan (no workload context). */
function rowsFromResult(image: string, res: models.TrivyScanResult): models.TrivyVulnRow[] {
    const out: models.TrivyVulnRow[] = [];
    (res.targets || []).forEach((tg) => {
        (tg.vulnerabilities || []).forEach((v, i) => {
            out.push(models.TrivyVulnRow.createFrom({
                key: `${image}|${tg.target}|${v.vulnerabilityID}|${v.pkgName}|${i}`,
                workload: NO_WORKLOAD,
                image,
                imageRepo: '',
                target: tg.target,
                class: tg.class,
                vulnerabilityID: v.vulnerabilityID,
                pkgName: v.pkgName,
                pkgPath: v.pkgPath,
                installedVersion: v.installedVersion,
                fixedVersion: v.fixedVersion,
                severity: (v.severity || 'UNKNOWN').toUpperCase(),
                title: v.title,
                description: v.description || '',
                primaryURL: v.primaryURL,
                publishedDate: v.publishedDate || '',
                references: v.references || [],
                isNew: false,
                accepted: false,
            }));
        });
    });
    return out;
}

/** The single-image scan's state, held by the root so it survives switching tabs. */
export function useImageScanner(clusterName: string, pushToast: PushToast) {
    const t = useT();
    const [rows, setRows] = useState<models.TrivyVulnRow[]>([]);
    const [results, setResults] = useState<models.TrivyScanResult[]>([]);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState<Progress>(null);
    const [log, setLog] = useState('');
    const [error, setError] = useState('');
    const [imageInput, setImageInput] = useState('');

    const scanImages = async (images: string[]) => {
        if (images.length === 0) { setError(t('panels:trivy.logNoImages')); return; }
        setError('');
        setRows([]);
        setResults([]);
        setScanning(true);
        setLog(`$ trivy image  ${t('panels:trivy.logQueued', { count: images.length })}`);
        const acc: models.TrivyVulnRow[] = [];
        const accResults: models.TrivyScanResult[] = [];
        try {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                setProgress({ current: i + 1, total: images.length, image });
                setLog(`${t('panels:trivy.logScanning', { image, current: i + 1, total: images.length })}${i === 0 ? ` ${t('panels:trivy.logFirstRun')}` : ''}`);
                try {
                    const res = await TrivyScanImage(clusterName, image);
                    accResults.push(res);
                    setResults([...accResults]);
                    if (res.error) {
                        pushToast('warn', t('panels:trivy.toastScanIssue', { image }), res.error);
                    } else {
                        acc.push(...rowsFromResult(image, res));
                        setRows([...acc]);
                    }
                } catch (e) {
                    pushToast('error', t('panels:trivy.toastScanFailed', { image }), errText(e));
                }
            }
            setLog(t('panels:trivy.logDone', { findings: acc.length, images: images.length }));
            if (acc.length === 0) pushToast('success', t('panels:trivy.toastNoVulns'));
        } finally {
            setScanning(false);
            setProgress(null);
        }
    };

    return { rows, results, scanning, progress, log, error, scanImages, imageInput, setImageInput };
}

export default function ImageScanTab({ clusterName, scanner, pushToast }: {
    clusterName: string;
    scanner: ReturnType<typeof useImageScanner>;
    pushToast: PushToast;
}) {
    const t = useT();
    const [detail, setDetail] = useState<DetailFinding | null>(null);
    const run = () => {
        const ref = scanner.imageInput.trim();
        if (!ref) { pushToast('warn', t('panels:trivy.toastEnterImage'), t('panels:trivy.toastEnterImageHint')); return; }
        void scanner.scanImages([ref]);
    };

    const exportHtml = async () => {
        try {
            const path = await TrivyExportImageReport(clusterName, scanner.results, reportLabels(t, ''));
            if (path) pushToast('success', t('panels:trivy.reportSaved'), path);
        } catch (e) {
            pushToast('error', t('panels:trivy.reportFailed'), errText(e));
        }
    };

    const summary = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const r of scanner.rows) counts[r.severity] = (counts[r.severity] || 0) + 1;
        return counts;
    }, [scanner.rows]);

    return (
        <div className="flex flex-column gap-3">
            <Message severity="info" text={t('panels:trivy.dbHint')} />
            {scanner.error && <Message severity="error" text={scanner.error} />}

            <div className="flex flex-wrap align-items-center gap-2">
                <InputText
                    value={scanner.imageInput}
                    onChange={(e) => scanner.setImageInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && run()}
                    placeholder={t('panels:trivy.imagePlaceholder')}
                    disabled={scanner.scanning}
                    className="trivy-image-input"
                />
                <Button label={t('panels:trivy.scanImage')} icon={<VscPlay />} onClick={run} loading={scanner.scanning} />
            </div>

            {scanner.scanning && scanner.progress && (
                <div className="trivy-progress-line" role="status">
                    <span className="trivy-progress-line__text">{scanner.log}</span>
                    <ProgressBar value={Math.round((scanner.progress.current / scanner.progress.total) * 100)} showValue={false} className="trivy-progress" />
                </div>
            )}

            {scanner.rows.length > 0 && (
                <div className="trivy-tally">
                    {SEVERITIES.map((s) => summary[s] ? (
                        <span key={s} className="trivy-tally__item"><SeverityTag sev={s} /><span className="cell-count">{summary[s]}</span></span>
                    ) : null)}
                    <span className="trivy-tally__item trivy-tally__item--total">{t('panels:trivy.total')} <span className="cell-count">{scanner.rows.length}</span></span>
                </div>
            )}

            <div className="flex justify-content-end">
                <Button label={t('panels:trivy.exportHtml')} icon={<VscExport />} outlined size="small"
                    disabled={scanner.results.length === 0} onClick={() => void exportHtml()} />
            </div>

            <VulnTable rows={scanner.rows} cluster={false}
                empty={t(scanner.scanning ? 'panels:trivy.scanningImages' : 'panels:trivy.noVulnerabilities')}
                onOpen={(r) => setDetail(vulnToFinding(r))} />
            <FindingDetailDialog finding={detail} onHide={() => setDetail(null)} />
        </div>
    );
}
