import { useState } from 'react';
import { VscTrash } from 'react-icons/vsc';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { TrivyRemoveException } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { absTime } from '../../../lib/time';
import { errText } from '../../../lib/errText';
import RowAction from '../../shared/RowAction';
import StatusLamp from '../../shared/StatusLamp';
import { workloadLabel } from './workloadNav';
import type { PushToast } from './useClusterScan';

function ImageStatus({ c }: { c: models.TrivyImageCoverage }) {
    const t = useT();
    return c.status === 'scanned'
        ? <StatusLamp tone="ok" label={t('panels:trivy.coverage.scanned')} />
        : <StatusLamp tone="err" label={t('panels:trivy.coverage.failed')} />;
}

function ImageReason({ c }: { c: models.TrivyImageCoverage }) {
    const t = useT();
    if (!c.reason) return <span className="cell-empty">—</span>;
    return <span title={c.message}>{t(`panels:trivy.reason.${c.reason}` as never, { defaultValue: c.reason })}</span>;
}

function ExceptionScope({ e }: { e: models.TrivyException }) {
    return e.kind === 'vuln'
        ? <span className="cell-mono">{e.vulnerabilityId} · {e.imageRepo}</span>
        : <span className="cell-mono">{e.checkId} · {e.workload?.kind} {workloadLabel(e.workload)}</span>;
}

/** What the scan covered (each image and, when it failed, why) and the accepted risks. */
export default function CoverageView({ clusterName, view, onChanged, pushToast }: {
    clusterName: string;
    view: models.TrivyScanView;
    onChanged: () => void;
    pushToast: PushToast;
}) {
    const t = useT();
    const [removing, setRemoving] = useState<string | null>(null);

    const remove = async (id: string) => {
        setRemoving(id);
        try {
            await TrivyRemoveException(clusterName, id);
            onChanged();
        } catch (e) {
            pushToast('error', t('panels:trivy.toastRemoveFailed'), errText(e));
        } finally {
            setRemoving(null);
        }
    };

    return (
        <div className="trivy-coverage">
            <section className="trivy-card">
                <h3 className="trivy-card__title">{t('panels:trivy.coverage.images')}</h3>
                <DataTable value={view.coverage ?? []} dataKey="image" size="small" scrollable
                    emptyMessage={t('panels:trivy.coverage.noImages')}>
                    <Column field="image" header={t('resources:column.image')} bodyClassName="cell-mono" sortable />
                    <Column field="status" header={t('resources:column.status')} body={(c: models.TrivyImageCoverage) => <ImageStatus c={c} />} sortable style={{ width: 120 }} />
                    <Column field="reason" header={t('resources:column.reason')} body={(c: models.TrivyImageCoverage) => <ImageReason c={c} />} sortable />
                    <Column header={t('panels:trivy.col.workloads')} body={(c: models.TrivyImageCoverage) => <span className="cell-count">{(c.workloads ?? []).length}</span>} style={{ width: 110 }} />
                    <Column field="pullSecret" header={t('panels:trivy.col.pullSecret')} bodyClassName="cell-mono"
                        body={(c: models.TrivyImageCoverage) => c.pullSecret || <span className="cell-empty">—</span>} />
                </DataTable>
            </section>

            <section className="trivy-card">
                <h3 className="trivy-card__title">{t('panels:trivy.coverage.exceptions')}</h3>
                <DataTable value={view.exceptions ?? []} dataKey="exception.id" size="small" scrollable
                    emptyMessage={t('panels:trivy.coverage.noExceptions')}>
                    <Column header={t('panels:trivy.col.state')} style={{ width: 110 }}
                        body={(s: models.TrivyExceptionState) => s.expired
                            ? <StatusLamp tone="warn" label={t('panels:trivy.coverage.expired')} />
                            : <StatusLamp tone="ok" label={t('panels:trivy.coverage.active')} />} />
                    <Column header={t('panels:trivy.col.scope')} body={(s: models.TrivyExceptionState) => <ExceptionScope e={s.exception} />} />
                    <Column field="exception.reason" header={t('panels:trivy.accept.reason')} />
                    <Column header={t('panels:trivy.accept.expires')} style={{ width: 170 }}
                        body={(s: models.TrivyExceptionState) => absTime(s.exception.expiresAt)} />
                    <Column field="matches" header={t('panels:trivy.col.matches')} style={{ width: 100 }}
                        body={(s: models.TrivyExceptionState) => <span className="cell-count">{s.matches}</span>} />
                    <Column header="" style={{ width: 56 }}
                        body={(s: models.TrivyExceptionState) => (
                            <RowAction icon={<VscTrash size={14} />} label={t('action.remove')} severity="danger"
                                loading={removing === s.exception.id} disabled={removing != null}
                                onClick={() => void remove(s.exception.id)} />
                        )} />
                </DataTable>
            </section>
        </div>
    );
}
