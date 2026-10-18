import { useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTableFilterMeta } from 'primereact/datatable';
import { Column, ColumnFilterElementTemplateOptions } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import { FilterMatchMode } from 'primereact/api';
import { MultiSelect } from 'primereact/multiselect';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { VscAdd, VscClose, VscCheck } from 'react-icons/vsc';
import { GetNamespaces, DeleteNamespace, CreateNamespace } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { errText } from '../../lib/errText';
import ResourceListView from '../shared/ResourceListView';
import { useT } from '../../i18n/useT';

type Severity = 'success' | 'warning' | 'danger' | 'info' | 'secondary' | 'contrast' | undefined;

const getStatusSeverity = (status: string): Severity => {
    switch (status) {
        case 'Active':      return 'success';
        case 'Terminating': return 'danger';
        default:            return 'warning';
    }
};

const defaultFilters: DataTableFilterMeta = {
    name:   { value: null, matchMode: FilterMatchMode.CONTAINS },
    status: { value: null, matchMode: FilterMatchMode.IN },
};

/**
 * Create dialog for a new namespace.
 *
 * Only the name and optional `key=value` labels are collected: anything richer
 * belongs in the YAML editor, which already exists. The name itself is not
 * validated here — the API server owns the DNS-1123 rules and its rejection is
 * shown verbatim, which stays correct as those rules change.
 */
function NewNamespaceButton({ clusterName, reload }: { clusterName: string; reload: () => Promise<void> }) {
    const t = useT();
    const [visible, setVisible] = useState(false);
    const [name, setName] = useState('');
    const [labelText, setLabelText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        if (busy) return;
        setVisible(false);
        setName('');
        setLabelText('');
        setError(null);
    };

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            const labels: Record<string, string> = {};
            for (const pair of labelText.split(',')) {
                const trimmed = pair.trim();
                if (!trimmed) continue;
                const eq = trimmed.indexOf('=');
                if (eq <= 0) throw new Error(`label "${trimmed}" must be key=value`);
                labels[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
            }
            await CreateNamespace(clusterName, name.trim(), labels);
            setVisible(false);
            setName('');
            setLabelText('');
            await reload();
        } catch (e) {
            setError(errText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Button
                label={t('resources:namespace.create')}
                icon={<VscAdd size={16} />}
                size="small"
                onClick={() => setVisible(true)}
            />
            <Dialog
                header={t('resources:namespace.createTitle')}
                visible={visible}
                className="scale-dialog"
                modal
                onHide={close}
                footer={
                    <div className="dlg-actions">
                        <Button label={t('action.cancel')} icon={<VscClose size={16} />} text onClick={close} disabled={busy} />
                        <Button
                            label={t('resources:namespace.createConfirm')}
                            icon={<VscCheck size={16} />}
                            onClick={create}
                            loading={busy}
                            disabled={!name.trim()}
                        />
                    </div>
                }
            >
                <div className="dlg-form">
                    <div className="dlg-field">
                        <label htmlFor="ns-name" className="dlg-label">{t('resources:column.name')}</label>
                        <InputText
                            id="ns-name"
                            value={name}
                            autoFocus
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) create(); }}
                            placeholder={t('resources:namespace.namePlaceholder')}
                        />
                    </div>
                    <div className="dlg-field">
                        <label htmlFor="ns-labels" className="dlg-label">
                            {t('resources:namespace.labels')}{' '}
                            <span className="dlg-label__hint">{t('resources:namespace.labelsHint')}</span>
                        </label>
                        <InputText
                            id="ns-labels"
                            value={labelText}
                            onChange={(e) => setLabelText(e.target.value)}
                            placeholder={t('resources:namespace.labelsPlaceholder')}
                        />
                    </div>
                    {error && <p className="dlg-error">{error}</p>}
                </div>
            </Dialog>
        </>
    );
}

export default function NamespaceListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openYamlPanel } = useTabContext();
    const referencePanel = `namespaces:${clusterName}`;

    return (
        <ResourceListView<models.NamespaceInfo>
            title={t('resources:namespace.title')}
            clusterName={clusterName}
            api={api}
            fetcher={GetNamespaces}
            createFrom={models.NamespaceInfo.createFrom}
            deleter={DeleteNamespace}
            deleteLabel="namespace"
            pollInterval={10000}
            describeResource="namespaces"
            defaultFilters={defaultFilters}
            emptyMessage={t('resources:namespace.empty')}
            toolbarExtra={({ reload }) => <NewNamespaceButton clusterName={clusterName} reload={reload} />}
            onRowDoubleClick={(ns) => openYamlPanel({ clusterName, resourceKind: 'namespace', name: ns.name, namespace: '', referencePanel })}
            columns={({ buildInOptions }) => (
                <>
                    <Column field="name" header={t('resources:column.name')} sortable filter filterField="name" filterPlaceholder={t('resources:filter.searchName')} showFilterMenu={false} style={{ minWidth: '14rem' }} />
                    <Column field="status" header={t('resources:column.status')} sortable filter filterField="status" showFilterMenu={false} style={{ minWidth: '9rem' }}
                        body={(row: models.NamespaceInfo) => <StatusLamp label={row.status} severity={getStatusSeverity(row.status)} />}
                        filterElement={(options: ColumnFilterElementTemplateOptions) => (
                            <MultiSelect value={options.value} options={buildInOptions('status')} onChange={(e) => options.filterApplyCallback(e.value)} placeholder={t('filter.all')} filter maxSelectedLabels={1} style={{ minWidth: '8rem', maxWidth: '100%' }} />
                        )} />
                </>
            )}
        />
    );
}
