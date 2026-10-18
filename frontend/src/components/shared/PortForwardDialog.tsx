import { useEffect, useRef, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { VscArrowSwap, VscLock } from 'react-icons/vsc';
import { GetForwardablePorts, SuggestLocalPort, StartPortForward } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';
import Spinner from './Spinner';

export type ForwardableKind = 'pod' | 'deployment' | 'statefulset' | 'replicaset' | 'daemonset' | 'service';

const CUSTOM = -1;

/**
 * Starts a port forward against one row.
 *
 * The remote port is *picked*, not typed: the dialog asks the backend for the
 * target's real ports and offers them by name. Having to remember which port a
 * service listens on is the step that sends people back to `kubectl get svc`,
 * and it is the one this dialog exists to remove. A "Custom…" entry still
 * accepts anything, because a container can listen on a port it never declared.
 *
 * The local port is suggested rather than demanded: the backend prefers the
 * remote port so the address reads the way the user expects, and steps past it
 * when it is taken.
 */
export default function PortForwardDialog({
    visible,
    clusterName,
    kind,
    name,
    namespace,
    onHide,
    onStarted,
}: {
    visible: boolean;
    clusterName: string;
    kind: ForwardableKind;
    name: string;
    namespace: string;
    onHide: () => void;
    onStarted: (info: models.PortForwardInfo) => void;
}) {
    const t = useT();
    const [options, setOptions] = useState<models.PortOption[]>([]);
    const [loadingPorts, setLoadingPorts] = useState(false);
    const [portsError, setPortsError] = useState<string | null>(null);

    const [remotePort, setRemotePort] = useState<number | null>(null);
    const [customPort, setCustomPort] = useState<number | null>(null);
    const [localPort, setLocalPort] = useState<number | null>(null);
    const [suggestedAway, setSuggestedAway] = useState(false);

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The dialog is unmounted the moment it is dismissed, which the user may do
    // while a start is still in flight. This guards the state writes that land
    // afterwards.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const usingCustom = remotePort === CUSTOM;
    const effectiveRemote = usingCustom ? customPort : remotePort;

    // The same component instance is reused across openings, so everything is
    // reset here rather than at mount.
    useEffect(() => {
        if (!visible) return;
        let cancelled = false;

        setOptions([]);
        setRemotePort(null);
        setCustomPort(null);
        setLocalPort(null);
        setSuggestedAway(false);
        setError(null);
        setPortsError(null);
        setLoadingPorts(true);

        GetForwardablePorts(clusterName, kind, name, namespace)
            .then((found) => {
                if (cancelled) return;
                const list = (found ?? []).map(models.PortOption.createFrom);
                setOptions(list);
                // One declared port is not a choice — pick it.
                const usable = list.filter((p) => p.protocol !== 'UDP');
                if (usable.length > 0) setRemotePort(usable[0].port);
                else setRemotePort(CUSTOM);
            })
            .catch((e) => {
                if (cancelled) return;
                // A target whose ports cannot be listed is still forwardable —
                // the user just has to name the port. Degrade, do not block.
                setPortsError(errText(e));
                setRemotePort(CUSTOM);
            })
            .finally(() => {
                if (!cancelled) setLoadingPorts(false);
            });

        return () => {
            cancelled = true;
        };
    }, [visible, clusterName, kind, name, namespace]);

    // Suggest a local port whenever the remote one changes.
    useEffect(() => {
        if (!visible || !effectiveRemote || effectiveRemote < 1) return;
        let cancelled = false;
        SuggestLocalPort(effectiveRemote)
            .then((port) => {
                if (cancelled) return;
                setLocalPort(port === 0 ? null : port);
                setSuggestedAway(port !== 0 && port !== effectiveRemote);
            })
            .catch(() => {
                if (!cancelled) setLocalPort(effectiveRemote);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, effectiveRemote]);

    // Dismissable even while starting, on purpose. A forward is owned by the
    // backend, not by this dialog: if the start succeeds after the user walked
    // away it simply appears in the Port Forwards panel and the title-bar pill,
    // which is where it belongs anyway. Blocking Cancel here would only trap
    // the user in front of a spinner they cannot do anything about.
    const close = () => onHide();

    const submit = async () => {
        if (!effectiveRemote || effectiveRemote < 1) return;
        setBusy(true);
        setError(null);
        try {
            const info = await StartPortForward(
                clusterName,
                kind,
                name,
                namespace,
                localPort ?? 0,
                effectiveRemote,
            );
            onStarted(models.PortForwardInfo.createFrom(info));
            onHide();
        } catch (e) {
            if (alive.current) setError(errText(e));
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const dropdownOptions = [
        ...options.map((p) => ({
            label: `${p.name ? `${p.name} · ` : ''}${p.port}/${p.protocol}${p.container_name ? ` · ${p.container_name}` : ''}`,
            value: p.port,
            // Port forwarding is a TCP stream; a UDP port is visible but not
            // selectable, which explains its absence better than hiding it.
            disabled: p.protocol === 'UDP',
        })),
        { label: t('panels:portForwardDialog.custom'), value: CUSTOM, disabled: false },
    ];

    return (
        <Dialog
            header={t('action.portForward')}
            visible={visible}
            className="pf-dialog"
            modal
            onHide={close}
            footer={
                <div className="dlg-actions">
                    <Button label={t('action.cancel')} severity="secondary" size="small" onClick={close} />
                    <Button
                        label={t('panels:portForwardDialog.start')}
                        icon={<VscArrowSwap size={14} />}
                        size="small"
                        onClick={submit}
                        loading={busy}
                        disabled={busy || !effectiveRemote || effectiveRemote < 1}
                    />
                </div>
            }
        >
            <div className="dlg-form">
                <p className="dlg-subject">
                    <span className="dlg-subject__kind">{kind}</span>
                    <span className="cell-mono">{namespace}/{name}</span>
                </p>

                <div className="dlg-field">
                    <label htmlFor="pf-remote" className="dlg-label">{t('panels:portForwardDialog.remotePort')}</label>
                    {loadingPorts ? (
                        <div className="dlg-loading">
                            <Spinner size={14} label={t('panels:portForwardDialog.readingPorts')} />
                            <span>{t('panels:portForwardDialog.readingPorts')}</span>
                        </div>
                    ) : (
                        <Dropdown
                            inputId="pf-remote"
                            value={remotePort}
                            options={dropdownOptions}
                            optionDisabled="disabled"
                            onChange={(e) => setRemotePort(e.value)}
                            placeholder={t('panels:portForwardDialog.selectPort')}
                            className="w-full"
                        />
                    )}
                    {usingCustom && (
                        <InputNumber
                            value={customPort}
                            min={1}
                            max={65535}
                            useGrouping={false}
                            placeholder={t('panels:portForwardDialog.portNumber')}
                            autoFocus
                            onValueChange={(e) => setCustomPort(e.value ?? null)}
                            className="w-full"
                            inputClassName="w-full"
                        />
                    )}
                    {portsError && (
                        <span className="dlg-note">{t('panels:portForwardDialog.portsError', { error: portsError })}</span>
                    )}
                </div>

                <div className="dlg-field">
                    <label htmlFor="pf-local" className="dlg-label">
                        {t('panels:portForwardDialog.localPort')}{' '}
                        <span className="dlg-label__hint">{t('panels:portForwardDialog.localPortHint')}</span>
                    </label>
                    <InputNumber
                        inputId="pf-local"
                        value={localPort}
                        min={1}
                        max={65535}
                        useGrouping={false}
                        placeholder={t('panels:portForwardDialog.automatic')}
                        onValueChange={(e) => {
                            setLocalPort(e.value ?? null);
                            setSuggestedAway(false);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !busy) submit();
                        }}
                        className="w-full"
                        inputClassName="w-full"
                    />
                    {suggestedAway && effectiveRemote && (
                        <span className="dlg-note dlg-note--warn">
                            {t('panels:portForwardDialog.inUse', { port: effectiveRemote, suggested: localPort })}
                        </span>
                    )}
                </div>

                <span className="dlg-note dlg-note--icon">
                    <VscLock size={13} aria-hidden />
                    {t('panels:portForwardDialog.loopbackOnly')}
                </span>

                {error && <p className="dlg-error" role="alert">{error}</p>}
            </div>
        </Dialog>
    );
}
