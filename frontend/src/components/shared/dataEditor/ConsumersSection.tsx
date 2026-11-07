import { useState } from 'react';
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc';
import type { models } from '../../../../wailsjs/go/models';
import { useTabContext } from '../../../contexts/TabContext';
import { useT } from '../../../i18n/useT';
import StatusLamp from '../StatusLamp';

/** Plural resource of a consumer's kind, as the Describe panel takes it. */
export const consumerResource = (kind: string) => `${kind.toLowerCase()}s`;

/** Kinds a rolling restart exists for (services.RestartWorkload). */
export const RESTARTABLE = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

export type Consumers = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; items: models.DataConsumer[] };

/**
 * "Used by": the workloads whose pods read this object, and whether they only
 * see a change after a restart (env, envFrom, subPath).
 */
export default function ConsumersSection({ consumers, clusterName, namespace }: {
    consumers: Consumers;
    clusterName: string;
    namespace: string;
}) {
    const t = useT();
    const { openDescribePanel } = useTabContext();
    const [open, setOpen] = useState(true);
    const count = consumers.state === 'ok' ? consumers.items.length : undefined;

    return (
        <section className="de-consumers">
            <button type="button" className="de-consumers__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? <VscChevronDown size={14} aria-hidden /> : <VscChevronRight size={14} aria-hidden />}
                <span>{t('panels:dataEditor.usedBy')}</span>
                {count !== undefined && <span className="de-consumers__count">{count}</span>}
            </button>
            {open && (
                <div className="de-consumers__body">
                    {consumers.state === 'loading' && <p className="de-consumers__note">{t('status.loading')}</p>}
                    {consumers.state === 'error' && <p className="de-consumers__note">{t('panels:dataEditor.usedByError', { message: consumers.message })}</p>}
                    {consumers.state === 'ok' && consumers.items.length === 0 && (
                        <p className="de-consumers__note">{t('panels:dataEditor.usedByNone')}</p>
                    )}
                    {consumers.state === 'ok' && consumers.items.map((c) => (
                        <button
                            type="button"
                            key={`${c.kind}/${c.name}`}
                            className="de-consumer"
                            onClick={() => openDescribePanel({ clusterName, resource: consumerResource(c.kind), name: c.name, namespace, referencePanel: '' })}
                            title={t('panels:dataEditor.openDescribe')}
                        >
                            <span className="de-consumer__ref">{c.kind}/{c.name}</span>
                            <span className="de-consumer__usage">{c.usages.join(', ')}</span>
                            {c.needsRestart && <StatusLamp tone="warn" label={t('panels:dataEditor.needsRestart')} />}
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}
