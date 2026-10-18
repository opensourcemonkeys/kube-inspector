import { models } from '../../../../wailsjs/go/models';
import { absTime, humanAge } from '../../../lib/time';
import { useT } from '../../../i18n/useT';
import { containerDotColor, fmtCpu, fmtMem } from '../podStatus';
import { Item, Muted } from './DrawerItems';
import { RefLink, type Nav } from './refs';

/** "cpu 100m · memory 128Mi" from the numeric fields; "" when neither is set. */
function cpuMem(cpuMillis: number, memMi: number): string {
    const parts: string[] = [];
    if (cpuMillis > 0) parts.push(`cpu ${fmtCpu(cpuMillis)}`);
    if (memMi > 0) parts.push(`memory ${fmtMem(memMi)}`);
    return parts.join(' · ');
}

/**
 * One container, laid out like the rest of the panel: a label/value list.
 * Values that come from the cluster (states, reasons, images, paths) stay
 * verbatim; only the labels are translated.
 */
export default function ContainerSection({ c, volumes, usage, nav }: {
    c: models.PodContainerDetail;
    volumes: models.PodVolumeInfo[];
    /** undefined while unknown, null when metrics are unavailable. */
    usage?: models.ContainerUsage | null;
    nav: Nav;
}) {
    const t = useT();
    const st = c.status;
    const dot = st ? containerDotColor(st) : 'var(--ink-3)';
    const ports = c.ports ?? [];
    const env = c.env ?? [];
    const envFrom = c.env_from ?? [];
    const mounts = c.mounts ?? [];
    const probes = c.probes ?? [];
    const command = c.command ?? [];
    const args = c.args ?? [];
    const requests = cpuMem(c.cpu_request_millis, c.mem_request_mi);
    const limits = cpuMem(c.cpu_limit_millis, c.mem_limit_mi);
    const volumeByName = new Map(volumes.map((v) => [v.name, v]));

    // A finished container says how it finished: Kubernetes marks a completed
    // init container ready, which would read as "still running".
    const stateText = !st ? t('resources:pod.containerUnknownState')
        : st.state === 'Terminated' ? `${st.state}: ${st.reason || ''}`.replace(/: $/, '')
        : st.state === 'Waiting' ? `${st.state}: ${st.reason || ''}`.replace(/: $/, '')
        : st.state;

    return (
        <div className="pd-container" style={{ ['--dot' as string]: dot }}>
            <div className="pd-container__title">
                <span className={`pd-dot${c.init ? ' pd-dot--square' : ''}`} />
                <span className="pd-container__name">{c.name}</span>
            </div>

            <Item label={t('resources:column.status')}>
                <span className={dot === 'var(--ink-3)' || dot === 'var(--ok)' ? undefined : 'pd-state--tinted'}>{stateText}</span>
                {st && st.state === 'Running' && <Muted>{`, ${st.ready ? t('resources:pod.containerReady') : t('resources:pod.containerNotReady')}`}</Muted>}
                {st && st.restart_count > 0 && <Muted>{` · ${t('resources:column.restarts')}: ${st.restart_count}`}</Muted>}
                {c.started_at && <Muted>{` · ${t('resources:pod.detail.startedAgo', { age: humanAge(c.started_at) })}`}</Muted>}
                {c.state_message && <div className="pd-note">{c.state_message}</div>}
            </Item>
            {c.last_state && (
                <Item label={t('resources:pod.detail.lastStatus')}>
                    {c.last_state}
                    {c.last_state_at && <span title={absTime(c.last_state_at)}><Muted>{` · ${t('resources:pod.detail.ago', { age: humanAge(c.last_state_at) })}`}</Muted></span>}
                </Item>
            )}
            <Item label={t('resources:column.image')}><span>{c.image}</span></Item>
            {c.image_pull_policy && <Item label={t('resources:pod.detail.imagePullPolicy')}>{c.image_pull_policy}</Item>}
            {ports.length > 0 && (
                <Item label={t('resources:column.ports')}>
                    <div className="pd-stack">{ports.map((p) => <span key={p}>{p}</span>)}</div>
                </Item>
            )}
            {(env.length > 0 || envFrom.length > 0) && (
                <Item label={t('resources:pod.detail.environment')}>
                    <div className="pd-stack">
                        {envFrom.map((f) => (
                            <span key={`${f.ref.kind}/${f.ref.name}`} className="pd-line">
                                <Muted>{t('resources:pod.detail.allKeysFrom')}</Muted>
                                <RefLink r={f.ref} nav={nav} showKind />
                                {f.prefix && <Muted>{t('resources:pod.detail.prefix', { prefix: f.prefix })}</Muted>}
                                {f.optional && <Muted>{t('resources:pod.detail.optional')}</Muted>}
                            </span>
                        ))}
                        {env.map((e) => (
                            <span key={e.name} className="pd-line">
                                <span className="pd-env-name">{e.name}</span>
                                {e.ref ? (
                                    <>
                                        <span className="pd-arrow" aria-hidden />
                                        <RefLink r={e.ref} nav={nav} showKind />
                                        <span>{`: ${e.key}`}</span>
                                        {e.optional && <Muted>{t('resources:pod.detail.optional')}</Muted>}
                                    </>
                                ) : e.source ? (
                                    <>
                                        <span className="pd-arrow" aria-hidden />
                                        <Muted>{`${e.source}: ${e.key}`}</Muted>
                                    </>
                                ) : (
                                    <span className="pd-env-value" title={e.value}>{`= ${e.value}`}</span>
                                )}
                            </span>
                        ))}
                    </div>
                </Item>
            )}
            {mounts.length > 0 && (
                <Item label={t('resources:pod.detail.mounts')}>
                    <div className="pd-stack">
                        {mounts.map((m) => {
                            const v = volumeByName.get(m.volume);
                            return (
                                <div key={`${m.volume}:${m.mount_path}:${m.sub_path}`} className="pd-mount">
                                    <span>{m.mount_path}{m.sub_path ? ` (${m.sub_path})` : ''}</span>
                                    <span className="pd-line">
                                        <Muted>{t('resources:pod.detail.from', { volume: m.volume })}</Muted>
                                        {v && (v.refs ?? []).length > 0 && v.type !== 'projected' && <RefLink r={v.refs[0]} nav={nav} showKind />}
                                        {m.read_only && <Muted>{t('resources:pod.detail.readOnly')}</Muted>}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </Item>
            )}
            {probes.map((p) => (
                <Item key={p.kind} label={t(`resources:pod.detail.probe.${p.kind}` as never)}>
                    <span>{p.handler}</span>
                    <div><Muted>{p.timing}</Muted></div>
                </Item>
            ))}
            {command.length > 0 && <Item label={t('resources:pod.detail.command')}><span>{command.join(' ')}</span></Item>}
            {args.length > 0 && <Item label={t('resources:pod.detail.arguments')}><span>{args.join(' ')}</span></Item>}
            {requests && <Item label={t('resources:pod.detail.requests')}>{requests}</Item>}
            {limits && <Item label={t('resources:pod.detail.limits')}>{limits}</Item>}
            {(c.other_resources ?? []).length > 0 && (
                <Item label={t('resources:pod.detail.otherResources')}>
                    <div className="pd-stack">{c.other_resources.map((o) => <span key={o}>{o}</span>)}</div>
                </Item>
            )}
            {usage && (
                <Item label={t('resources:pod.detail.usage')}>
                    {`cpu ${fmtCpu(usage.cpuMillis)} · memory ${fmtMem(usage.memMi)}`}
                </Item>
            )}
        </div>
    );
}
