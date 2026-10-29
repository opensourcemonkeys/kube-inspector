import type { ReactNode } from 'react';
import { VscClose } from 'react-icons/vsc';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import RowAction from '../../shared/RowAction';
import StatusLamp from '../../shared/StatusLamp';
import { formatTime } from './format';

/**
 * One write the API server refused: who sent it from where, what it asked
 * for (the request URI is the whole request line) and the server's reason in
 * full, which the list can only show cut short.
 */
export default function AttemptDetail({ attempt: a, onClose }: { attempt: models.ToolboxAttempt; onClose: () => void }) {
    const t = useT();
    const object = `${a.group ? a.group + '/' : ''}${a.resource}${a.subresource ? '/' + a.subresource : ''}`;
    const name = `${a.namespace ? a.namespace + '/' : ''}${a.name || '—'}`;
    const facts: [string, ReactNode][] = [
        [t('panels:clusterHistory.detail.time'), formatTime(a.time)],
        [t('panels:clusterHistory.col.response'), <StatusLamp label={`${a.responseCode} ${a.responseReason ?? ''}`} tone="err" />],
        [t('panels:clusterHistory.col.verb'), a.verb],
        [t('panels:clusterHistory.detail.object'), `${object} ${name}`],
        [t('panels:clusterHistory.detail.user'), a.username || '—'],
    ];
    if (a.impersonatedBy) facts.push([t('panels:clusterHistory.detail.impersonatedBy'), a.impersonatedBy]);
    if (a.groups?.length) facts.push([t('panels:clusterHistory.detail.groups'), a.groups.join(', ')]);
    if (a.sourceIPs?.length) facts.push([t('panels:clusterHistory.detail.sourceIps'), a.sourceIPs.join(', ')]);
    if (a.userAgent) facts.push([t('panels:clusterHistory.detail.userAgent'), a.userAgent]);
    if (a.requestUri) facts.push([t('panels:clusterHistory.attempt.requestUri'), <span className="cell-mono history-attempt__uri">{a.requestUri}</span>]);
    if (a.auditId) facts.push([t('panels:clusterHistory.detail.auditId'), <span className="cell-mono">{a.auditId}</span>]);
    const title = `${a.verb} ${object} · ${name}`;

    return (
        <div className="history-detail">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label history-detail__title" title={title}>{title}</span>
                <div className="panel-toolbar__actions">
                    <RowAction icon={<VscClose size={14} />} label={t('panels:clusterHistory.detail.close')} onClick={onClose} />
                </div>
            </div>
            <div className="history-attempt">
                <dl className="dlg-facts history-detail__facts history-attempt__facts">
                    {facts.map(([k, v]) => (
                        <div className="dlg-facts__row" key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                        </div>
                    ))}
                </dl>
                {a.responseMessage && (
                    <>
                        <h3 className="history-attempt__heading">{t('panels:clusterHistory.attempt.message')}</h3>
                        <pre className="history-attempt__message dark-display">{a.responseMessage}</pre>
                    </>
                )}
            </div>
        </div>
    );
}
