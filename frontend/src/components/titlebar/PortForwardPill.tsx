import { useEffect, useRef } from 'react';
import { OverlayPanel } from 'primereact/overlaypanel';
import { VscGlobe, VscCopy, VscClose } from 'react-icons/vsc';
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { StopPortForward } from '../../../wailsjs/go/controller_app/App';
import {
    usePortForwardStore,
    isWebForward,
    forwardUrl,
    forwardAddress,
} from '../../stores/portForwardStore';
import { writeClipboard } from '../../lib/clipboard';
import { useT } from '../../i18n/useT';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import RowAction from '../shared/RowAction';

/**
 * Live tunnel count in the title bar.
 *
 * A port forward outlives the panel that opened it — that is the whole point —
 * which means the panel cannot be the thing that tells you one is running. This
 * pill is the only always-visible answer to "did I leave a tunnel open?", so it
 * subscribes to the store directly rather than through the panel.
 *
 * It appears only when there is something to report; an empty pill would be
 * permanent title-bar furniture that says nothing.
 */
const PF_TONE: Record<string, LampTone> = { ready: 'ok', starting: 'info', reconnecting: 'warn', error: 'err' };

export default function PortForwardPill({ onOpenPanel }: { onOpenPanel: () => void }) {
    const t = useT();
    const forwards = usePortForwardStore((s) => s.forwards);
    const startSync = usePortForwardStore((s) => s.startSync);
    const refresh = usePortForwardStore((s) => s.refresh);
    const overlay = useRef<OverlayPanel>(null);

    // One subscription per window, started here rather than in the panel so the
    // count keeps updating while the panel is closed. startSync is idempotent.
    useEffect(() => startSync(), [startSync]);

    if (forwards.length === 0) return null;

    const failed = forwards.some((f) => f.status === 'error');
    const unsettled = forwards.some((f) => f.status === 'reconnecting' || f.status === 'starting');
    const tone = failed ? 'tb-pf--error' : unsettled ? 'tb-pf--warn' : '';

    const stop = async (id: string) => {
        try {
            await StopPortForward(id);
        } finally {
            await refresh();
        }
    };

    return (
        <>
            <button
                className={`tb-pf ${tone}`}
                title={t('panels:portForward.pillTitle')}
                onClick={(e) => overlay.current?.toggle(e)}
                onDoubleClick={onOpenPanel}
            >
                <StatusLamp
                    label={t('panels:portForward.pill', { count: forwards.length })}
                    tone={failed ? 'err' : unsettled ? 'warn' : 'ok'}
                />
            </button>

            <OverlayPanel ref={overlay} className="pf-overlay">
                <div className="pf-overlay__list">
                    {forwards.map((f) => (
                        <div key={f.id} className="pf-overlay__row">
                            <StatusLamp markOnly label={f.status} tone={PF_TONE[f.status] ?? 'idle'} />
                            <span className="pf-overlay__addr">{forwardAddress(f)}</span>
                            <span className="pf-overlay__target">
                                {f.resource_kind}/{f.resource_name}
                            </span>
                            <span className="pf-overlay__actions">
                                {isWebForward(f) && (
                                    <RowAction icon={<VscGlobe size={13} />} label={t('panels:portForward.openInBrowser')}
                                        onClick={() => BrowserOpenURL(forwardUrl(f))} />
                                )}
                                <RowAction icon={<VscCopy size={13} />} label={t('panels:portForward.copyAddress')}
                                    onClick={() => void writeClipboard(forwardAddress(f))} />
                                <RowAction icon={<VscClose size={13} />} label={t('panels:portForward.stop')} severity="danger"
                                    onClick={() => void stop(f.id)} />
                            </span>
                        </div>
                    ))}
                </div>
                <button
                    className="pf-overlay__more"
                    onClick={(e) => {
                        overlay.current?.toggle(e);
                        onOpenPanel();
                    }}
                >
                    {t('panels:portForward.openPanel')}
                </button>
            </OverlayPanel>
        </>
    );
}
