import { useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { models } from '../../../wailsjs/go/models';
import {
    ExportDiagnostics,
    GetDiagnostics,
    GetLogDir,
    OpenLogFolder,
    RunHealthChecks,
} from '../../../wailsjs/go/controller_app/App';
import { useAiChatStore } from '../../stores/aiChatStore';
import { useDiagnosticsStore } from '../../stores/diagnosticsStore';
import { writeClipboard } from '../../lib/clipboard';
import { renderReport } from '../../lib/diagnosticsReport';
import { useT } from '../../i18n/useT';
import { VscCopy, VscDesktopDownload, VscFolderOpened } from 'react-icons/vsc';

function humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * The export tab. Everything it produces is redacted on the Go side before it
 * reaches a file or the clipboard — there is no unredacted path out of the app.
 */
export default function ExportTab({ report }: { report: models.DiagnosticsReport | null }) {
    const t = useT();
    const toast = useRef<Toast | null>(null);
    const [busy, setBusy] = useState(false);
    const ollamaHost = useAiChatStore((s) => s.host);
    const uiErrors = useDiagnosticsStore((s) => s.uiErrors);

    const saveZip = () => {
        setBusy(true);
        ExportDiagnostics(ollamaHost)
            .then((path) => {
                // An empty path with no error means the user cancelled the
                // dialog; that is not something to announce.
                if (!path) return;
                toast.current?.show({
                    severity: 'success',
                    summary: 'Diagnostics saved',
                    detail: path,
                    life: 4000,
                });
            })
            .catch((e) =>
                toast.current?.show({
                    severity: 'error',
                    summary: 'Export failed',
                    detail: String(e),
                    life: 5000,
                }),
            )
            .finally(() => setBusy(false));
    };

    const copyReport = async () => {
        setBusy(true);
        try {
            const [rep, checks] = await Promise.all([
                GetDiagnostics(),
                RunHealthChecks(ollamaHost),
            ]);
            const ok = await writeClipboard(renderReport(rep, checks, undefined, uiErrors));
            toast.current?.show({
                severity: ok ? 'success' : 'error',
                summary: ok ? 'Copied' : 'Could not copy',
                detail: ok ? 'The report is on your clipboard.' : 'The clipboard is unavailable here.',
                life: 2500,
            });
        } catch (e) {
            toast.current?.show({
                severity: 'error',
                summary: 'Could not build the report',
                detail: String(e),
                life: 5000,
            });
        } finally {
            setBusy(false);
        }
    };

    const openFolder = () => {
        OpenLogFolder().catch(async () => {
            // Browser mode has no file manager to reach. Hand over the path
            // instead of failing silently.
            const dir = await GetLogDir().catch(() => '');
            const ok = dir ? await writeClipboard(dir) : false;
            toast.current?.show({
                severity: 'warn',
                summary: 'Cannot open a folder here',
                detail: ok ? `Path copied: ${dir}` : dir || 'Log directory unknown.',
                life: 5000,
            });
        });
    };

    const files = report?.logFiles ?? [];
    const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);

    return (
        <div className="diag-tab">
            <Toast ref={toast} position="bottom-right" />

            <section className="diag-section">
                <h3 className="diag-section__title">{t('panels:diagnostics.exportTitle')}</h3>
                <p className="diag-note">{t('panels:diagnostics.exportNote')}</p>
            </section>

            <section className="diag-section">
                <div className="diag-section__head">
                    <h3 className="diag-section__title">{t('panels:diagnostics.logFiles')}</h3>
                    <span className="diag-row__value">{t('panels:diagnostics.logsTotal', { size: humanBytes(total) })}</span>
                </div>
                {files.length === 0 && <div className="diag-empty">{t('panels:diagnostics.noLogFiles')}</div>}
                {files.map((f) => (
                    <div className="diag-row" key={f.name}>
                        <span className="diag-row__label">{f.name}</span>
                        <span className="diag-row__value">
                            {humanBytes(f.sizeBytes)} · {f.modifiedAt}
                        </span>
                    </div>
                ))}
                <p className="diag-note">{t('panels:diagnostics.retentionNote')}</p>
            </section>

            <section className="diag-section diag-actions">
                <Button
                    label={t('panels:diagnostics.saveZip')}
                    icon={<VscDesktopDownload />}
                    disabled={busy}
                    onClick={saveZip}
                />
                <Button
                    label={t('panels:diagnostics.copyReport')}
                    icon={<VscCopy />}
                    outlined
                    disabled={busy}
                    onClick={copyReport}
                />
                <Button
                    label={t('panels:diagnostics.openLogFolder')}
                    icon={<VscFolderOpened />}
                    outlined
                    onClick={openFolder}
                />
            </section>
        </div>
    );
}
