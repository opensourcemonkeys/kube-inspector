import { VscPlay, VscStopCircle, VscFilePdf } from 'react-icons/vsc';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { InputSwitch } from 'primereact/inputswitch';
import { ProgressBar } from 'primereact/progressbar';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { absTime } from '../../../lib/time';
import { useTrivyStore } from '../../../stores/trivyStore';
import type { useClusterScan } from './useClusterScan';

/**
 * Scan / Stop, which saved scan is shown and what it is compared with, the
 * report (wired by a later step) and the AI-suggestions switch. Progress is
 * one line of text, with a bar while images are being scanned.
 */
export default function ScanToolbar({ scan, scans, scanId, compareId, onSelect, onCompare }: {
    scan: ReturnType<typeof useClusterScan>;
    scans: models.TrivyScanMeta[];
    scanId: string | null;
    compareId: string;
    onSelect: (id: string) => void;
    onCompare: (id: string) => void;
}) {
    const t = useT();
    const aiSuggestions = useTrivyStore((s) => s.aiSuggestions);
    const setAiSuggestions = useTrivyStore((s) => s.setAiSuggestions);

    const option = (s: models.TrivyScanMeta) => ({
        value: s.id,
        label: t('panels:trivy.scanOption', { date: absTime(s.startedAt), critical: s.critical, high: s.high }),
    });
    const scanOptions = scans.map(option);
    const compareOptions = [
        { value: '', label: t('panels:trivy.noCompare') },
        ...scans.filter((s) => s.id !== scanId).map(option),
    ];

    return (
        <div className="trivy-toolbar-wrap">
            <div className="trivy-toolbar">
                {!scan.running ? (
                    <Button label={t('panels:trivy.scanCluster')} icon={<VscPlay />} onClick={() => void scan.start()} />
                ) : (
                    <Button label={scan.stopping ? t('panels:trivy.stopping') : t('panels:trivy.stop')} icon={<VscStopCircle />}
                        severity="danger" disabled={scan.stopping} onClick={scan.stop} />
                )}
                <Dropdown className="trivy-toolbar__select p-inputtext-sm" value={scanId} options={scanOptions}
                    onChange={(e) => onSelect(e.value)} disabled={scans.length === 0}
                    placeholder={t('panels:trivy.noScansShort')} aria-label={t('panels:trivy.scanPicker')} />
                <Dropdown className="trivy-toolbar__select p-inputtext-sm" value={compareId} options={compareOptions}
                    onChange={(e) => onCompare(e.value)} disabled={scans.length < 2}
                    aria-label={t('panels:trivy.comparePicker')} />
                <span className="trivy-toolbar__spacer" />
                <label className="trivy-switch">
                    <InputSwitch checked={aiSuggestions} onChange={(e) => setAiSuggestions(!!e.value)} />
                    <span>{t('panels:trivy.aiSuggestions')}</span>
                </label>
                <Button label={t('panels:trivy.report')} icon={<VscFilePdf />} outlined disabled
                    tooltip={t('panels:trivy.reportPending')} tooltipOptions={{ showOnDisabled: true }} />
            </div>
            {(scan.line || scan.percent != null) && (
                <div className="trivy-progress-line" role="status">
                    <span className="trivy-progress-line__text">{scan.line}</span>
                    {scan.running && scan.percent != null && (
                        <ProgressBar value={scan.percent} showValue={false} className="trivy-progress" />
                    )}
                </div>
            )}
            <span className="trivy-muted">{t('panels:trivy.clusterHint')}</span>
        </div>
    );
}
