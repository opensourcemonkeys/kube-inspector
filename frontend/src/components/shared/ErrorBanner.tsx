import { useEffect, useState } from 'react';
import { VscRefresh, VscCopy, VscClose, VscCheck } from 'react-icons/vsc';
import { copyDiagnostics } from '../../lib/diagnosticsReport';
import { useT } from '../../i18n/useT';

export interface ErrorBannerProps {
    /** The failure text. Render nothing when null — callers can pass state directly. */
    message: string | null;
    /** Refetch. Omit for surfaces with no manual refresh. */
    onRetry?: () => void;
    /** True while a retry/poll is in flight; spins the Retry button. */
    busy?: boolean;
    /**
     * True when rows from a previous successful fetch are still on screen. The
     * strip then says the data is stale rather than implying nothing loaded.
     */
    stale?: boolean;
    /** What failed, e.g. "pods list" — used in the copied diagnostics report. */
    context?: string;
    /**
     * Render as a block that takes the place of the content, for a failure
     * with nothing behind it. A strip above an empty table read as "loaded,
     * and there are none of these" with a footnote; the block says the list
     * could not be read at all, from which cluster, and shows the whole error.
     */
    block?: boolean;
    /** Names the cluster in the block's heading. */
    cluster?: string;
}

/**
 * The one error surface every list and dashboard uses.
 *
 * Since beta-plan S7 the backend wraps list failures as
 * `list pods in cluster "prod": pods is forbidden: …`, so `message` is shown
 * verbatim: an RBAC 403, an unreachable API server and a bad kubeconfig each
 * read differently here, which is the whole point of the step. Never replace it
 * with a generic string.
 *
 * Dismissal is per message: closing the strip hides *this* failure, and a
 * different one re-opens it. A poll that keeps failing with the same text stays
 * hidden, which is what a user who dismissed it asked for.
 */
export default function ErrorBanner({ message, onRetry, busy, stale, context, block, cluster }: ErrorBannerProps) {
    const t = useT();
    const [dismissed, setDismissed] = useState(false);
    const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

    useEffect(() => {
        setDismissed(false);
        setCopied('idle');
    }, [message]);

    if (!message || (dismissed && !block)) return null;

    const copy = async () => {
        const ok = await copyDiagnostics(context ? `${context}: ${message}` : message);
        setCopied(ok ? 'ok' : 'fail');
        window.setTimeout(() => setCopied('idle'), 2500);
    };

    const retryButton = onRetry && (
        <button type="button" className="err-banner__btn" onClick={onRetry} disabled={busy}>
            <VscRefresh className={busy ? 'err-banner__spin' : undefined} /> {t('errors:banner.retry')}
        </button>
    );
    const copyButton = (
        <button type="button" className="err-banner__btn" onClick={copy}>
            {copied === 'ok' ? <VscCheck /> : <VscCopy />}
            {copied === 'ok'
                ? t('errors:banner.copied')
                : copied === 'fail'
                  ? t('errors:banner.copyFailed')
                  : t('errors:banner.copyDiagnostics')}
        </button>
    );

    if (block) {
        return (
            <div className="err-block" role="alert">
                <div className="err-block__head">
                    <span className="err-block__lamp" aria-hidden="true" />
                    <span className="err-block__title">
                        {cluster ? t('errors:block.title', { cluster }) : t('errors:boundary.panelTitle')}
                    </span>
                </div>
                {/* Verbatim and whole: an RBAC 403 and an unreachable API
                    server must read differently, so nothing is truncated. */}
                <pre className="err-block__msg">{message}</pre>
                <div className="err-block__actions">
                    {retryButton}
                    {copyButton}
                </div>
            </div>
        );
    }

    return (
        <div className="err-banner" role="alert">
            <span className="err-banner__lamp" aria-hidden="true" />
            <div className="err-banner__body">
                {stale && <span className="err-banner__tag">{t('errors:banner.stale')}</span>}
                <span className="err-banner__msg" title={message}>{message}</span>
            </div>
            <div className="err-banner__actions">
                {retryButton}
                {copyButton}
                <button
                    type="button"
                    className="err-banner__btn err-banner__btn--icon"
                    onClick={() => setDismissed(true)}
                    title={t('errors:banner.dismiss')}
                    aria-label={t('errors:banner.dismiss')}
                >
                    <VscClose />
                </button>
            </div>
        </div>
    );
}
