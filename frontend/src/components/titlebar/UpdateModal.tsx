import { useEffect, useRef, useState } from 'react';
import { VscDesktopDownload } from 'react-icons/vsc';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { ProgressBar } from 'primereact/progressbar';
import { StartSelfUpdate, CancelSelfUpdate } from '../../../wailsjs/go/controller_app/App';
import { EventsOn, EventsOff, BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { models } from '../../../wailsjs/go/models';
import { relaunchApp, quitApp, supportsSelfRestart } from '../../lib/shellWindows';
import { useT } from '../../i18n/useT';
import ChangelogNotes from './ChangelogNotes';

interface Props {
    visible: boolean;
    onHide: () => void;
    info: models.UpdateInfo;
}

/** Mirrors models.UpdateProgress. It only travels over events, so Wails does not
 *  generate a binding for it. */
interface UpdateProgress {
    phase: 'download' | 'install';
    received: number;
    total: number;
    percent: number;
}

type Stage = 'idle' | 'downloading' | 'installing' | 'done' | 'error';

// Long enough for "Update complete" to register before the window disappears.
const RESTART_DELAY_MS = 1200;

const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
};

export default function UpdateModal({ visible, onHide, info }: Props) {
    const t = useT();
    const [stage, setStage] = useState<Stage>('idle');
    const [progress, setProgress] = useState<UpdateProgress | null>(null);
    const [error, setError] = useState('');
    const sessionRef = useRef<string>('');

    // The updater can only finish the job under a shell that can restart the
    // whole app. Everywhere else (Wails dev shell, browser tab) fall back to the
    // downloads page, which is what the pill did before this modal existed.
    const canInstall = info.installable && supportsSelfRestart();
    const busy = stage === 'downloading' || stage === 'installing';

    // Reset whenever the dialog is reopened, but never while an update is in
    // flight — reopening must not restart a running download.
    useEffect(() => {
        if (visible && !busy) {
            setStage('idle');
            setProgress(null);
            setError('');
        }
    }, [visible]);

    const start = () => {
        const id = `update-${Date.now()}`;
        sessionRef.current = id;
        setError('');
        setProgress(null);
        setStage('downloading');

        EventsOn(`update:progress:${id}`, (p: UpdateProgress) => {
            setProgress(p);
            setStage(p.phase === 'install' ? 'installing' : 'downloading');
        });
        EventsOn(`update:done:${id}`, (d: { restart: string }) => {
            setStage('done');
            window.setTimeout(
                () => (d.restart === 'relaunch' ? relaunchApp() : quitApp()),
                RESTART_DELAY_MS,
            );
        });
        EventsOn(`update:error:${id}`, (d: { message: string }) => {
            setError(d.message || t('panels:update.installFailed'));
            setStage('error');
        });

        StartSelfUpdate(id).catch((e) => {
            setError(String(e));
            setStage('error');
        });
    };

    const detach = (id: string) => {
        EventsOff(`update:progress:${id}`);
        EventsOff(`update:done:${id}`);
        EventsOff(`update:error:${id}`);
    };

    const cancel = () => {
        const id = sessionRef.current;
        if (id) {
            CancelSelfUpdate(id).catch(() => { /* already finished */ });
            detach(id);
            sessionRef.current = '';
        }
        setStage('idle');
        setProgress(null);
        onHide();
    };

    // Drop the listeners on unmount. The download itself is cancelled only from
    // the explicit Cancel button — closing this window should not abort an
    // install that is already talking to the package manager.
    useEffect(() => () => { if (sessionRef.current) detach(sessionRef.current); }, []);

    const downloadPercent = progress && progress.phase === 'download' ? progress.percent : 0;
    const indeterminateDownload = stage === 'downloading' && (progress?.total ?? -1) <= 0;

    // This dialog is now mounted whenever a check has returned, not only when
    // there is something to install — otherwise switching update channel, or
    // asking Help ▸ Check for updates, produced no feedback whatsoever.
    const failed = !!info.failedUpdateVersion;
    const nothingToInstall = !info.available;

    const title = stage === 'done' ? t('panels:update.titleDone')
        : failed && nothingToInstall ? t('panels:update.failedTitle')
        : nothingToInstall ? t('panels:update.titleUpToDate')
        : t('panels:update.titleAvailable');

    const openDownloads = () => BrowserOpenURL(info.downloadUrl);

    // One primary action per state, on the right; the way out beside it.
    let actions: React.ReactNode;
    if (nothingToInstall) {
        actions = (
            <>
                {(failed || info.aheadOfChannel) && (
                    <Button label={t('panels:update.openDownloads')} text size="small" onClick={openDownloads} />
                )}
                <Button label={t('panels:update.close')} severity="secondary" size="small" onClick={onHide} />
            </>
        );
    } else if (canInstall) {
        actions = stage === 'idle' ? (
            <>
                <Button label={t('panels:update.later')} severity="secondary" size="small" onClick={onHide} />
                <Button label={t('panels:update.updateNow')} icon={<VscDesktopDownload size={14} />} size="small" onClick={start} autoFocus />
            </>
        ) : stage === 'downloading' ? (
            <Button label={t('panels:update.cancel')} severity="secondary" size="small" onClick={cancel} />
        ) : stage === 'error' ? (
            <>
                <Button label={t('panels:update.openDownloads')} text size="small" onClick={openDownloads} />
                <Button label={t('panels:update.tryAgain')} size="small" onClick={start} />
            </>
        ) : null;
    } else {
        actions = (
            <>
                <Button label={t('panels:update.later')} severity="secondary" size="small" onClick={onHide} />
                <Button label={t('panels:update.openDownloads')} icon={<VscDesktopDownload size={14} />} size="small"
                    onClick={() => { openDownloads(); onHide(); }} autoFocus />
            </>
        );
    }

    // Download, then install: two segments of one rail. A finished segment is
    // solid ink, the running one is the accent, the next one is the bare rail.
    const segment = (step: 'download' | 'install') => {
        const active = step === 'download' ? stage === 'downloading' : stage === 'installing';
        const done = step === 'download' ? stage === 'installing' || stage === 'done' : stage === 'done';
        return `update-rail__step${active ? ' is-active' : done ? ' is-done' : ''}`;
    };

    return (
        <Dialog
            visible={visible}
            onHide={() => { if (!busy) onHide(); }}
            header={title}
            footer={actions ? <div className="dlg-actions">{actions}</div> : null}
            closable={!busy}
            closeOnEscape={!busy}
            modal
            className="update-modal"
        >
            {/* Only when there is something to move to. On the stable
                channel latestVersion can be empty (no stable release yet) or
                older than what is running, and "0.16.0-beta.3 → 0.15.0"
                would read as an offer to downgrade. */}
            {!nothingToInstall && (
                <dl className="dlg-facts update-modal__versions">
                    <dt>{t('panels:update.installed')}</dt>
                    <dd className="dlg-facts__mono">{info.currentVersion}</dd>
                    <dt>{t('panels:update.available')}</dt>
                    <dd className="dlg-facts__mono update-modal__new">{info.latestVersion}</dd>
                </dl>
            )}
            {!nothingToInstall && <ChangelogNotes from={info.currentVersion} to={info.latestVersion} />}

            {nothingToInstall ? (
                <div className="update-modal__body">
                    {failed ? (
                        <>
                            <p className="update-modal__desc update-modal__desc--err">
                                {t('panels:update.failedBody', {
                                    version: info.failedUpdateVersion,
                                    current: info.currentVersion,
                                })}
                            </p>
                            {/* The macOS swap helper runs after the app has
                                quit, so this log is the only account of what
                                it did. Absent on every other platform. */}
                            {info.failedUpdateLog && (
                                <details className="update-modal__log">
                                    <summary>{t('panels:update.failedLog')}</summary>
                                    <pre>{info.failedUpdateLog}</pre>
                                </details>
                            )}
                        </>
                    ) : info.aheadOfChannel ? (
                        <p className="update-modal__desc">
                            {t('panels:update.aheadOfChannel', {
                                current: info.currentVersion,
                                latest: info.latestVersion,
                                channel: info.channel,
                            })}
                        </p>
                    ) : (
                        <p className="update-modal__desc">
                            {t('panels:update.upToDate', {
                                version: info.currentVersion,
                                channel: info.channel,
                            })}
                        </p>
                    )}
                </div>
            ) : canInstall ? (
                <div className="update-modal__body">
                    <ol className="update-rail" aria-label={t('panels:update.progressLabel')}>
                        <li className={segment('download')}>{t('panels:update.stepDownload')}</li>
                        <li className={segment('install')}>{t('panels:update.stepInstall')}</li>
                    </ol>

                    {stage === 'idle' && (
                        <p className="update-modal__desc">{t('panels:update.intro')}</p>
                    )}

                    {stage === 'downloading' && (
                        <>
                            <ProgressBar
                                className="update-modal__bar"
                                mode={indeterminateDownload ? 'indeterminate' : 'determinate'}
                                value={Math.round(downloadPercent)}
                                showValue={false}
                            />
                            <div className="update-modal__status">
                                {progress && progress.total > 0
                                    ? <>
                                        {t('panels:update.downloadingProgress', {
                                            received: formatBytes(progress.received),
                                            total: formatBytes(progress.total),
                                        })}
                                        <span className="update-modal__pct">{Math.round(downloadPercent)}%</span>
                                    </>
                                    : t('panels:update.downloading')}
                            </div>
                        </>
                    )}

                    {stage === 'installing' && (
                        <>
                            <ProgressBar className="update-modal__bar" mode="indeterminate" />
                            <div className="update-modal__status">
                                {t('panels:update.installing')} {info.assetKind === 'deb' || info.assetKind === 'rpm'
                                    ? t('panels:update.installingPassword')
                                    : t('panels:update.installingQuick')}
                            </div>
                            <div className="update-modal__hint">{t('panels:update.doNotClose')}</div>
                        </>
                    )}

                    {stage === 'done' && (
                        <div className="update-modal__status">{t('panels:update.restarting')}</div>
                    )}

                    {stage === 'error' && (
                        <div className="update-modal__error" role="alert">{error}</div>
                    )}
                </div>
            ) : (
                <div className="update-modal__body">
                    <p className="update-modal__desc">
                        {info.notInstallableReason
                            ? t('panels:update.notInstallable', { reason: info.notInstallableReason })
                            : t('panels:update.downloadFromSite')}
                    </p>
                </div>
            )}
        </Dialog>
    );
}
