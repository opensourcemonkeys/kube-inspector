import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { Button } from 'primereact/button';




import { VscClose, VscAdd, VscDiscard, VscCheck, VscSettings } from 'react-icons/vsc';
import { Column, ColumnEditorOptions, ColumnEvent } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { InputText } from 'primereact/inputtext';
import { Toast } from 'primereact/toast';
import { GetRoles, UpdateRole } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';

interface RoleEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

interface RuleRow {
    id: number;
    apiGroups: string;
    resources: string;
    verbs: string;
    resourceNames: string;
}

let rowCounter = 0;
const nextId = () => ++rowCounter;

function splitCSV(s: string): string[] {
    return s.split(',').map(v => v.trim()).filter(Boolean);
}

function rulesToRows(rules: models.PolicyRuleInfo[]): RuleRow[] {
    return (rules ?? []).map(r => ({
        id: nextId(),
        apiGroups:     (r.api_groups ?? []).join(', '),
        resources:     (r.resources ?? []).join(', '),
        verbs:         (r.verbs ?? []).join(', '),
        resourceNames: (r.resource_names ?? []).join(', '),
    }));
}

function rowsToRules(rows: RuleRow[]): models.PolicyRuleInfo[] {
    return rows.map(r => models.PolicyRuleInfo.createFrom({
        api_groups:     splitCSV(r.apiGroups),
        resources:      splitCSV(r.resources),
        verbs:          splitCSV(r.verbs),
        resource_names: splitCSV(r.resourceNames),
    }));
}

const rowsEqual = (a: RuleRow[], b: RuleRow[]) => {
    if (a.length !== b.length) return false;
    return a.every((row, i) =>
        row.apiGroups === b[i].apiGroups &&
        row.resources === b[i].resources &&
        row.verbs === b[i].verbs &&
        row.resourceNames === b[i].resourceNames
    );
};

export default function RoleEditorPanel({ params }: IDockviewPanelProps<RoleEditorPanelParams>) {
    const t = useT();
    const { clusterName, name, namespace } = params;
    const cn = clusterName ?? '';
    const [rows, setRows] = useState<RuleRow[]>([]);
    const [originalRows, setOriginalRows] = useState<RuleRow[]>([]);
    const [storedLabels, setStoredLabels] = useState<Record<string, string>>({});
    const [storedAnnotations, setStoredAnnotations] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const toast = useRef<Toast | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const all = await GetRoles(cn);
                const role = all.find((r: any) => r.name === name && r.namespace === namespace);
                if (!role) return;
                const loaded = rulesToRows(role.rules ?? []);
                setRows(loaded);
                setOriginalRows(loaded.map(r => ({ ...r })));
                setStoredLabels(role.labels ?? {});
                setStoredAnnotations(role.annotations ?? {});
            } catch {
                toast.current?.show({ severity: 'error', summary: 'Load failed', detail: `${namespace}/${name} could not be loaded`, life: 3500 });
            }
        };
        load();
    }, [name, namespace]);

    const onCellEditComplete = (e: ColumnEvent) => {
        const { rowIndex, field, newValue } = e;
        setRows(prev => {
            const next = prev.map((r, i) => i === rowIndex ? { ...r, [field]: newValue ?? '' } : r);
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const addRow = () => {
        setRows(prev => {
            const next = [...prev, { id: nextId(), apiGroups: '', resources: '', verbs: '', resourceNames: '' }];
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const removeRow = (id: number) => {
        setRows(prev => {
            const next = prev.filter(r => r.id !== id);
            setDirty(!rowsEqual(next, originalRows));
            return next;
        });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await UpdateRole(cn, name, namespace, storedLabels, storedAnnotations, rowsToRules(rows));
            setOriginalRows(rows.map(r => ({ ...r })));
            setDirty(false);
            toast.current?.show({ severity: 'success', summary: 'Updated', detail: `${namespace}/${name} updated`, life: 2500 });
        } catch {
            toast.current?.show({ severity: 'error', summary: 'Update failed', detail: `${namespace}/${name} could not be updated`, life: 3500 });
        } finally {
            setSaving(false);
        }
    };

    const handleRevert = () => {
        setRows(originalRows.map(r => ({ ...r })));
        setDirty(false);
    };

    const textEditor = (options: ColumnEditorOptions) => (
        <InputText
            value={options.value}
            onChange={e => options.editorCallback!(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem', width: '100%' }}
            autoFocus
        />
    );

    const actionsBody = (rowData: RuleRow) => (
        <Button
            icon={<VscClose size={16} />}
            text
            severity="danger"
            size="small"
            onClick={() => removeRow(rowData.id)}
            disabled={saving}
            style={{ padding: '0.2rem' }}
        />
    );

    const tableHeader = (
        <div className="flex justify-content-between align-items-center gap-2">
            <span className="yaml-editor-toolbar__label flex align-items-center gap-1" style={{ fontSize: '0.85rem' }}>
                <VscSettings size={14} />
                {namespace}/{name}
            </span>
            <div className="flex align-items-center gap-1">
                <Button label={t('panels:roleEditor.addRule')} icon={<VscAdd size={16} />} text size="small" onClick={addRow} disabled={saving} />
                <Button label={t('panels:yaml.revert')} icon={<VscDiscard size={16} />} text size="small" disabled={!dirty || saving} onClick={handleRevert} />
                <Button label={t('panels:yaml.save')} icon={<VscCheck size={16} />} size="small" loading={saving} disabled={!dirty} onClick={handleSave} />
            </div>
        </div>
    );

    return (
        <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Toast ref={toast} position="bottom-right" />
            <DataTable
                value={rows}
                dataKey="id"
                editMode="cell"
                header={tableHeader}
                scrollable
                scrollHeight="flex"
                showGridlines
                stripedRows
                emptyMessage={t('panels:roleEditor.empty')}
                style={{ flex: 1 }}
            >
                <Column field="apiGroups" header={t('resources:column.apiGroups')} editor={textEditor} onCellEditComplete={onCellEditComplete} style={{ minWidth: '11rem', fontFamily: 'monospace', fontSize: '0.85rem' }} />
                <Column field="resources" header={t('resources:column.resources')} editor={textEditor} onCellEditComplete={onCellEditComplete} style={{ minWidth: '11rem', fontFamily: 'monospace', fontSize: '0.85rem' }} />
                <Column field="verbs" header={t('resources:column.verbs')} editor={textEditor} onCellEditComplete={onCellEditComplete} style={{ minWidth: '11rem', fontFamily: 'monospace', fontSize: '0.85rem' }} />
                <Column field="resourceNames" header={t('resources:column.resourceNames')} editor={textEditor} onCellEditComplete={onCellEditComplete} style={{ minWidth: '11rem', fontFamily: 'monospace', fontSize: '0.85rem' }} />
                <Column header="" {...ACTION_COLUMN_PROPS} body={actionsBody} style={{ width: '3.5rem', textAlign: 'center' }} />
            </DataTable>
        </div>
    );
}
