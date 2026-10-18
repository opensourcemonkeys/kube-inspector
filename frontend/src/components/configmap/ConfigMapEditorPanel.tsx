import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { Button } from 'primereact/button';




import { VscClose, VscAdd, VscDiscard, VscCheck, VscSettings } from 'react-icons/vsc';
import { Column, ColumnEditorOptions, ColumnEvent } from 'primereact/column';
import { DataTable } from 'primereact/datatable';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { Toast } from 'primereact/toast';
import { GetConfigMapData, UpdateConfigMapData } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';
import RowAction from '../shared/RowAction';

interface ConfigMapEditorPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

interface KeyValueRow {
    id: number;
    key: string;
    value: string;
}

let rowCounter = 0;
const nextId = () => ++rowCounter;

const dataToRows = (data: Record<string, string>): KeyValueRow[] =>
    Object.entries(data)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ id: nextId(), key, value }));

const rowsEqual = (a: KeyValueRow[], b: KeyValueRow[]) => {
    if (a.length !== b.length) return false;
    return a.every((row, i) => row.key === b[i].key && row.value === b[i].value);
};

export default function ConfigMapEditorPanel({ params }: IDockviewPanelProps<ConfigMapEditorPanelParams>) {
    const t = useT();
    const { clusterName, name, namespace } = params;
    const cn = clusterName ?? '';
    const [rows, setRows] = useState<KeyValueRow[]>([]);
    const [originalRows, setOriginalRows] = useState<KeyValueRow[]>([]);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const toast = useRef<Toast | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const data = await GetConfigMapData(cn, name, namespace);
                const loaded = dataToRows(data ?? {});
                setRows(loaded);
                setOriginalRows(loaded.map(r => ({ ...r })));
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
            const next = [...prev, { id: nextId(), key: '', value: '' }];
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
        const data: Record<string, string> = {};
        for (const row of rows) {
            if (row.key.trim()) data[row.key.trim()] = row.value;
        }
        setSaving(true);
        try {
            await UpdateConfigMapData(cn, name, namespace, data);
            const saved = dataToRows(data);
            setOriginalRows(saved.map(r => ({ ...r })));
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

    const keyEditor = (options: ColumnEditorOptions) => (
        <InputText
            value={options.value}
            onChange={(e) => options.editorCallback!(e.target.value)}
            className="kv-input"
            autoFocus
        />
    );

    const valueEditor = (options: ColumnEditorOptions) => (
        <InputTextarea
            value={options.value}
            onChange={(e) => options.editorCallback!(e.target.value)}
            className="kv-input kv-input--area"
            autoResize
            rows={3}
        />
    );

    const valueBody = (rowData: KeyValueRow) => (
        <span className="kv-value">
            {rowData.value}
        </span>
    );

    const actionsBody = (rowData: KeyValueRow) => (
        <RowAction icon={<VscClose size={15} />} label={t('action.remove')} severity="danger"
            onClick={() => removeRow(rowData.id)} disabled={saving} />
    );

    const emptyState = (
        <div className="rlv-empty">
            <span>{t('panels:configMapEditor.empty')}</span>
            <Button label={t('panels:configMapEditor.addKey')} icon={<VscAdd size={14} />} outlined size="small" onClick={addRow} disabled={saving} />
        </div>
    );

    const tableHeader = (
        <div className="panel-toolbar">
            <span className="panel-toolbar__label">
                <VscSettings size={14} aria-hidden />
                <span className="cell-clip">{namespace}/{name}</span>
            </span>
            <div className="panel-toolbar__actions">
                <Button label={t('panels:configMapEditor.addKey')} icon={<VscAdd size={16} />} text size="small" onClick={addRow} disabled={saving} />
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
                <Column
                    field="key"
                    header={t('resources:column.key')}
                    editor={keyEditor}
                    onCellEditComplete={onCellEditComplete}
                    className="cell-mono" style={{ width: '30%', minWidth: '10rem' }}
                />
                <Column
                    field="value"
                    header={t('resources:column.value')}
                    editor={valueEditor}
                    onCellEditComplete={onCellEditComplete}
                    body={valueBody}
                    className="cell-mono"
                />
                <Column
                    header=""
                    {...ACTION_COLUMN_PROPS}
                    body={actionsBody}
                    style={{ width: '3.5rem' }}
                />
            </DataTable>
        </div>
    );
}
