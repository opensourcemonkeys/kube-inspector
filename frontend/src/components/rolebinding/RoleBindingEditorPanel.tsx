import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { Button } from 'primereact/button';




import { VscClose, VscAdd, VscDiscard, VscCheck, VscSettings } from 'react-icons/vsc';
import { Column, ColumnEditorOptions, ColumnEvent } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Toast } from 'primereact/toast';
import { GetRoleBindings, UpdateRoleBinding } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';
import RowAction from '../shared/RowAction';

interface RoleBindingEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

interface SubjectRow {
    id: number;
    kind: string;
    name: string;
    namespace: string;
}

const SUBJECT_KINDS = ['ServiceAccount', 'User', 'Group'];

let rowCounter = 0;
const nextId = () => ++rowCounter;

function subjectsToRows(subjects: models.SubjectInfo[]): SubjectRow[] {
    return (subjects ?? []).map(s => ({
        id: nextId(),
        kind: s.kind ?? '',
        name: s.name ?? '',
        namespace: s.namespace ?? '',
    }));
}

function rowsToSubjects(rows: SubjectRow[]): models.SubjectInfo[] {
    return rows.map(r => models.SubjectInfo.createFrom({ kind: r.kind, name: r.name, namespace: r.namespace }));
}

const rowsEqual = (a: SubjectRow[], b: SubjectRow[]) => {
    if (a.length !== b.length) return false;
    return a.every((row, i) =>
        row.kind === b[i].kind &&
        row.name === b[i].name &&
        row.namespace === b[i].namespace
    );
};

export default function RoleBindingEditorPanel({ params }: IDockviewPanelProps<RoleBindingEditorPanelParams>) {
    const t = useT();
    const { clusterName, name, namespace } = params;
    const cn = clusterName ?? '';
    const [rows, setRows] = useState<SubjectRow[]>([]);
    const [originalRows, setOriginalRows] = useState<SubjectRow[]>([]);
    const [storedLabels, setStoredLabels] = useState<Record<string, string>>({});
    const [storedAnnotations, setStoredAnnotations] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const toast = useRef<Toast | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const all = await GetRoleBindings(cn);
                const rb = all.find((r: any) => r.name === name && r.namespace === namespace);
                if (!rb) return;
                const loaded = subjectsToRows(rb.subjects ?? []);
                setRows(loaded);
                setOriginalRows(loaded.map(r => ({ ...r })));
                setStoredLabels(rb.labels ?? {});
                setStoredAnnotations(rb.annotations ?? {});
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
            const next = [...prev, { id: nextId(), kind: 'ServiceAccount', name: '', namespace: '' }];
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
            await UpdateRoleBinding(cn, name, namespace, storedLabels, storedAnnotations, rowsToSubjects(rows));
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

    const kindEditor = (options: ColumnEditorOptions) => (
        <Dropdown
            value={options.value}
            options={SUBJECT_KINDS}
            onChange={e => options.editorCallback!(e.value)}
            autoFocus
        />
    );

    const textEditor = (options: ColumnEditorOptions) => (
        <InputText
            value={options.value}
            onChange={e => options.editorCallback!(e.target.value)}
            className="kv-input"
            autoFocus
        />
    );

    const actionsBody = (rowData: SubjectRow) => (
        <RowAction icon={<VscClose size={15} />} label={t('action.remove')} severity="danger"
            onClick={() => removeRow(rowData.id)} disabled={saving} />
    );

    const emptyState = (
        <div className="rlv-empty">
            <span>{t('panels:roleBindingEditor.empty')}</span>
            <Button label={t('panels:roleBindingEditor.addSubject')} icon={<VscAdd size={14} />} outlined size="small" onClick={addRow} disabled={saving} />
        </div>
    );

    const tableHeader = (
        <div className="panel-toolbar">
            <span className="panel-toolbar__label">
                <VscSettings size={14} aria-hidden />
                <span className="cell-clip">{namespace}/{name}</span>
            </span>
            <div className="panel-toolbar__actions">
                <Button label={t('panels:roleBindingEditor.addSubject')} icon={<VscAdd size={16} />} text size="small" onClick={addRow} disabled={saving} />
                <Button label={t('panels:yaml.revert')} icon={<VscDiscard size={16} />} text size="small" disabled={!dirty || saving} onClick={handleRevert} />
                <Button label={t('panels:yaml.save')} icon={<VscCheck size={16} />} size="small" loading={saving} disabled={!dirty} onClick={handleSave} />
            </div>
        </div>
    );

    return (
        <div className="kv-editor">
            <Toast ref={toast} position="bottom-right" />
            {tableHeader}
            <DataTable
                value={rows}
                dataKey="id"
                editMode="cell"
                scrollable
                scrollHeight="flex"
                emptyMessage={emptyState}
                className="kv-editor__table"
            >
                <Column field="kind" header={t('resources:column.kind')} editor={kindEditor} onCellEditComplete={onCellEditComplete} style={{ width: '12rem', minWidth: '10rem' }} />
                <Column field="name" header={t('resources:column.name')} editor={textEditor} onCellEditComplete={onCellEditComplete} className="cell-mono" style={{ minWidth: '12rem' }} />
                <Column field="namespace" header={t('resources:column.namespace')} editor={textEditor} onCellEditComplete={onCellEditComplete} className="cell-mono" style={{ minWidth: '12rem' }} />
                <Column header="" {...ACTION_COLUMN_PROPS} body={actionsBody} style={{ width: '3.5rem' }} />
            </DataTable>
        </div>
    );
}
