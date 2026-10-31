import { useMemo, useState } from 'react';
import { VscLinkExternal } from 'react-icons/vsc';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputText } from 'primereact/inputtext';
import { MultiSelect } from 'primereact/multiselect';
import { FilterMatchMode } from 'primereact/api';
import { BrowserOpenURL } from '../../../../wailsjs/runtime/runtime';
import { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { SEVERITIES, SeverityTag, bySeverity } from './severity';
import { vulnUrl } from './FindingDetailDialog';

// The three finding tables. Rows come from the backend's scan view; a row
// double-click hands it to the caller, which owns the detail dialog.

// A component rather than a plain template function: it needs `t`, and PrimeReact
// invokes a filterElement template inline during the table's own render — a hook
// called there would join the *table's* hook sequence conditionally. As an element
// it gets its own.
function SeverityFilter({ options }: { options: any }) {
    const t = useT();
    return (
        <MultiSelect
            value={options.value}
            options={SEVERITIES.map((s) => ({ label: s, value: s }))}
            onChange={(e) => options.filterApplyCallback(e.value)}
            placeholder={t('panels:trivy.severity')}
            className="p-column-filter"
        />
    );
}

const severityFilterTemplate = (options: any) => <SeverityFilter options={options} />;

function NewMark({ isNew }: { isNew: boolean }) {
    const t = useT();
    return isNew ? <span className="cell-warn">{t('panels:trivy.findings.new')}</span> : null;
}

const rowClass = (r: { accepted?: boolean }) => (r.accepted ? 'cursor-pointer trivy-row--accepted' : 'cursor-pointer');

function SearchHeader({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const t = useT();
    return (
        <div className="flex justify-content-end">
            <InputText value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('panels:trivy.search')} />
        </div>
    );
}

const severityColumn = (t: ReturnType<typeof useT>) => (
    <Column field="severity" header={t('resources:column.severity')} body={(r: { severity: string }) => <SeverityTag sev={r.severity} />}
        sortable filter filterElement={severityFilterTemplate} showFilterMatchModes={false} style={{ width: 110 }} />
);

const defaultMisconfigFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    checkID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceKind: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceName: { value: null, matchMode: FilterMatchMode.CONTAINS },
    namespace: { value: null, matchMode: FilterMatchMode.CONTAINS },
};

export function MisconfigTable({ rows, empty, onOpen }: { rows: models.TrivyMisconfigRow[]; empty: string; onOpen: (r: models.TrivyMisconfigRow) => void }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultMisconfigFilters);
    const sorted = useMemo(() => bySeverity(rows), [rows]);
    return (
        <DataTable value={sorted} dataKey="key" size="small" scrollable paginator rows={50} rowsPerPageOptions={[25, 50, 100]}
            filters={filters} onFilter={(e) => setFilters(e.filters)} globalFilter={globalFilter}
            globalFilterFields={['checkID', 'resourceKind', 'resourceName', 'namespace', 'title', 'message']}
            filterDisplay="menu" onRowDoubleClick={(e) => onOpen(e.data as models.TrivyMisconfigRow)}
            rowClassName={rowClass} emptyMessage={empty}
            header={<SearchHeader value={globalFilter} onChange={setGlobalFilter} />}>
            {severityColumn(t)}
            <Column header="" body={(r: models.TrivyMisconfigRow) => <NewMark isNew={r.isNew} />} style={{ width: 56 }} />
            <Column field="checkID" header={t('resources:column.check')} sortable filter style={{ width: 100 }} />
            <Column field="resourceKind" header={t('resources:column.kind')} sortable filter style={{ width: 120 }} />
            <Column field="resourceName" header={t('resources:column.resource')} sortable filter />
            <Column field="namespace" header={t('resources:column.namespace')} sortable filter style={{ width: 130 }} />
            <Column field="title" header={t('resources:column.title')} />
            <Column field="resolution" header={t('resources:column.resolution')} style={{ maxWidth: 300 }} />
        </DataTable>
    );
}

const defaultSecretFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    ruleID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceKind: { value: null, matchMode: FilterMatchMode.CONTAINS },
    resourceName: { value: null, matchMode: FilterMatchMode.CONTAINS },
};

export function SecretTable({ rows, empty, onOpen }: { rows: models.TrivySecretRow[]; empty: string; onOpen: (r: models.TrivySecretRow) => void }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultSecretFilters);
    const sorted = useMemo(() => bySeverity(rows), [rows]);
    return (
        <DataTable value={sorted} dataKey="key" size="small" scrollable paginator rows={50} rowsPerPageOptions={[25, 50, 100]}
            filters={filters} onFilter={(e) => setFilters(e.filters)} globalFilter={globalFilter}
            globalFilterFields={['ruleID', 'category', 'resourceKind', 'resourceName', 'namespace', 'title', 'match']}
            filterDisplay="menu" onRowDoubleClick={(e) => onOpen(e.data as models.TrivySecretRow)}
            rowClassName={() => 'cursor-pointer'} emptyMessage={empty}
            header={<SearchHeader value={globalFilter} onChange={setGlobalFilter} />}>
            {severityColumn(t)}
            <Column header="" body={(r: models.TrivySecretRow) => <NewMark isNew={r.isNew} />} style={{ width: 56 }} />
            <Column field="ruleID" header={t('resources:column.ruleId')} sortable filter style={{ width: 160 }} />
            <Column field="category" header={t('resources:column.category')} sortable style={{ width: 160 }} />
            <Column field="resourceKind" header={t('resources:column.kind')} sortable filter style={{ width: 120 }} />
            <Column field="resourceName" header={t('resources:column.resource')} sortable filter />
            <Column field="namespace" header={t('resources:column.namespace')} sortable style={{ width: 130 }} />
            <Column field="title" header={t('resources:column.title')} />
            <Column field="match" header={t('resources:column.match')} className="cell-mono" style={{ maxWidth: 220 }} />
        </DataTable>
    );
}

const defaultVulnFilters: DataTableFilterMeta = {
    severity: { value: null, matchMode: FilterMatchMode.IN },
    vulnerabilityID: { value: null, matchMode: FilterMatchMode.CONTAINS },
    pkgName: { value: null, matchMode: FilterMatchMode.CONTAINS },
    image: { value: null, matchMode: FilterMatchMode.CONTAINS },
    'workload.kind': { value: null, matchMode: FilterMatchMode.CONTAINS },
    'workload.name': { value: null, matchMode: FilterMatchMode.CONTAINS },
};

const cveBody = (r: models.TrivyVulnRow) => {
    const url = vulnUrl(r.vulnerabilityID, r.primaryURL);
    return url ? (
        <a className="trivy-link trivy-link--inline" onClick={() => BrowserOpenURL(url)}>
            {r.vulnerabilityID} <VscLinkExternal />
        </a>
    ) : <span>{r.vulnerabilityID}</span>;
};
const fixedBody = (r: models.TrivyVulnRow) =>
    r.fixedVersion ? <span>{r.fixedVersion}</span> : <span className="cell-empty">—</span>;

/**
 * `cluster` shows the image, the workload and the "new" mark; the single-image
 * tab has none of them.
 */
export function VulnTable({ rows, empty, onOpen, cluster }: { rows: models.TrivyVulnRow[]; empty: string; onOpen: (r: models.TrivyVulnRow) => void; cluster: boolean }) {
    const t = useT();
    const [globalFilter, setGlobalFilter] = useState('');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultVulnFilters);
    const sorted = useMemo(() => bySeverity(rows), [rows]);
    return (
        <DataTable value={sorted} dataKey="key" size="small" scrollable paginator rows={50} rowsPerPageOptions={[25, 50, 100]}
            filters={filters} onFilter={(e) => setFilters(e.filters)} globalFilter={globalFilter}
            globalFilterFields={['vulnerabilityID', 'pkgName', 'image', 'title', 'workload.name']}
            filterDisplay="menu" onRowDoubleClick={(e) => onOpen(e.data as models.TrivyVulnRow)}
            rowClassName={rowClass} emptyMessage={empty}
            header={<SearchHeader value={globalFilter} onChange={setGlobalFilter} />}>
            {severityColumn(t)}
            {cluster && <Column header="" body={(r: models.TrivyVulnRow) => <NewMark isNew={r.isNew} />} style={{ width: 56 }} />}
            <Column field="vulnerabilityID" header={t('resources:column.vulnerability')} body={cveBody} sortable filter style={{ width: 170 }} />
            <Column field="pkgName" header={t('resources:column.package')} sortable filter />
            <Column field="installedVersion" header={t('resources:column.installed')} style={{ width: 110 }} />
            <Column field="fixedVersion" header={t('resources:column.fixed')} body={fixedBody} style={{ width: 110 }} />
            {cluster && <Column field="image" header={t('resources:column.image')} sortable filter className="cell-mono" style={{ maxWidth: 280 }} />}
            {cluster && <Column field="workload.kind" header={t('resources:column.kind')} sortable filter style={{ width: 110 }} />}
            {cluster && <Column field="workload.name" header={t('resources:column.resource')} sortable filter />}
            <Column field="title" header={t('resources:column.title')} />
        </DataTable>
    );
}
