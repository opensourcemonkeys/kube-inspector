import { useEffect, useRef, useState } from 'react';
import { VscCloudDownload, VscDesktopDownload, VscCheck, VscWarning } from 'react-icons/vsc';
import { Dialog } from 'primereact/dialog';
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

    const stepClass = (step: 1 | 2) => {
        const active = step === 1 ? stage === 'downloading' : stage === 'installing';
        const done = step === 1
            ? stage === 'installing' || stage === 'done'
            : stage === 'done';
        if (active) return 'update-modal__step update-modal__step--active';
        if (done) return 'update-modal__step update-modal__step--done';
        return 'update-modal__step';
    };

    const downloadPercent = progress && progress.phase === 'download' ? progress.percent : 0;
    const indeterminateDownload = stage === 'downloading' && (progress?.total ?? -1) <= 0;

    // This dialog is now mounted whenever a check has returned, not only when
    // there is something to install — otherwise switching update channel, or
    // asking Help ▸ Check for updates, produced no feedback whatsoever.
    const failed = !!info.failedUpdateVersion;
    const nothingToInstall = !info.available;

    return (
        <Dialog
            visible={visible}
            onHide={() => { if (!busy) onHide(); }}
            header={null}
            closable={false}
            closeOnEscape={!busy}
            modal
            className="update-modal"
            style={{ width: '560px', maxWidth: 'calc(100vw - 32px)' }}
        >
            <div className="update-modal__content">
                <div className="update-modal__logo">
                    {stage === 'done' || (nothingToInstall && !failed) ? <VscCheck className="update-modal__logo-icon" />
                        : stage === 'error' || failed ? <VscWarning className="update-modal__logo-icon update-modal__logo-icon--warn" />
                        : <VscCloudDownload className="update-modal__logo-icon" />}
                </div>

                <h2 className="update-modal__title">
                    {stage === 'done' ? t('panels:update.titleDone')
                        : failed && nothingToInstall ? t('panels:update.failedTitle')
                        : nothingToInstall ? t('panels:update.titleUpToDate')
                        : t('panels:update.titleAvailable')}
                </h2>

                {/* Only when there is something to move to. On the stable
                    channel latestVersion can be empty (no stable release yet) or
                    older than what is running, and "0.16.0-beta.3 → 0.15.0"
                    would read as an offer to downgrade. */}
                {!nothingToInstall && (
                    <div className="update-modal__versions">
                        <span className="update-modal__ver">{info.currentVersion}</span>
                        <span className="update-modal__arrow">→</span>
                        <span className="update-modal__ver update-modal__ver--new">{info.latestVersion}</span>
                    </div>
                )}
                {!nothingToInstall && <ChangelogNotes from={info.currentVersion} to={info.latestVersion} />}

                {nothingToInstall ? (
                    <div className="update-modal__body">
                        {failed ? (
                            <>
                                <p className="update-modal__desc">
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
                        <div className="update-modal__actions">
                            {(failed || info.aheadOfChannel) && (
                                <button className="update-modal__btn" onClick={() => BrowserOpenURL(info.downloadUrl)}>
                                    {t('panels:update.openDownloads')}
                                </button>
                            )}
                            <button className="update-modal__btn update-modal__btn--primary" onClick={onHide}>
                                {t('panels:update.close')}
                            </button>
                        </div>
                    </div>
                ) : canInstall ? (
                    <>
                        <div className="update-modal__steps">
                            <div className={stepClass(1)}>
                                <span className="update-modal__step-no">1</span>
                                <span className="update-modal__step-label">{t('panels:update.stepDownload')}</span>
                            </div>
                            <div className="update-modal__step-line" />
                            <div className={stepClass(2)}>
                                <span className="update-modal__step-no">2</span>
                                <span className="update-modal__step-label">{t('panels:update.stepInstall')}</span>
                            </div>
                        </div>

                        <div className="update-modal__body">
                            {stage === 'idle' && (
                                <p className="update-modal__desc">{t('panels:update.intro')}</p>
                            )}

                            {stage === 'downloading' && (
                                <>
                                    <ProgressBar
                                        className="update-modal__bar"
                                        mode={indeterminateDownload ? 'indeterminate' : 'determinate'}
                                        value={Math.round(downloadPercent)}
                                        showValue={!indeterminateDownload}
                                    />
                                    <div className="update-modal__status">
                                        {progress && progress.total > 0
                                            ? t('panels:update.downloadingProgress', {
                                                  received: formatBytes(progress.received),
                                                  total: formatBytes(progress.total),
                                              })
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
                                <div className="update-modal__error">{error}</div>
                            )}
                        </div>

                        <div className="update-modal__actions">
                            {stage === 'idle' && (
                                <>
                                    <button className="update-modal__btn" onClick={onHide}>{t('panels:update.later')}</button>
                                    <button className="update-modal__btn update-modal__btn--primary" onClick={start}>
                                        <VscDesktopDownload size={13} /> {t('panels:update.updateNow')}
                                    </button>
                                </>
                            )}
                            {stage === 'downloading' && (
                                <button className="update-modal__btn" onClick={cancel}>{t('panels:update.cancel')}</button>
                            )}
                            {stage === 'error' && (
                                <>
                                    <button className="update-modal__btn" onClick={() => BrowserOpenURL(info.downloadUrl)}>
                                        {t('panels:update.openDownloads')}
                                    </button>
                                    <button className="update-modal__btn update-modal__btn--primary" onClick={start}>
                                        {t('panels:update.tryAgain')}
                                    </button>
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="update-modal__body">
                        <p className="update-modal__desc">
                            {info.notInstallableReason
                                ? t('panels:update.notInstallable', { reason: info.notInstallableReason })
                                : t('panels:update.downloadFromSite')}
                        </p>
                        <div className="update-modal__actions">
                            <button className="update-modal__btn" onClick={onHide}>{t('panels:update.later')}</button>
                            <button
                                className="update-modal__btn update-modal__btn--primary"
                                onClick={() => { BrowserOpenURL(info.downloadUrl); onHide(); }}
                            >
                                <VscDesktopDownload size={13} /> {t('panels:update.openDownloads')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </Dialog>
    );
}
