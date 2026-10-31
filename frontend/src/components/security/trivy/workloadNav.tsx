import { VscGoToFile } from 'react-icons/vsc';
import { models } from '../../../../wailsjs/go/models';
import { useTabContext } from '../../../contexts/TabContext';
import { useT } from '../../../i18n/useT';
import RowAction from '../../shared/RowAction';
import { workloadYamlTarget } from './trivyModel';

export const workloadLabel = (w: models.TrivyWorkloadRef) => `${w.namespace ? `${w.namespace}/` : ''}${w.name}`;

/** Opens a workload's YAML beside the scan panel, through the typed panel when there is one. */
export function useOpenWorkloadYaml(clusterName: string) {
    const { openYamlPanel, openObjectYaml } = useTabContext();
    const referencePanel = `trivy:${clusterName}`;
    return (w: models.TrivyWorkloadRef): (() => void) | null => {
        const target = workloadYamlTarget(w.kind);
        if (!target || !w.name) return null;
        if ('typed' in target) {
            return () => openYamlPanel({
                clusterName, resourceKind: target.typed.yaml, name: w.name, namespace: w.namespace,
                referencePanel, titleView: target.typed.view,
            });
        }
        return () => openObjectYaml({
            clusterName, kind: w.kind, group: target.object.group, resource: target.object.resource,
            name: w.name, namespace: w.namespace, referencePanel,
        });
    };
}

/** "Kind ns/name" with an Open YAML action when the kind can be opened. */
export function WorkloadCell({ clusterName, w }: { clusterName: string; w: models.TrivyWorkloadRef }) {
    const t = useT();
    const open = useOpenWorkloadYaml(clusterName)(w);
    return (
        <span className="trivy-workload">
            <span className="trivy-workload__kind">{w.kind}</span>
            <span className="trivy-workload__name">{workloadLabel(w)}</span>
            {open && <RowAction icon={<VscGoToFile size={14} />} label={t('panels:trivy.fix.openYaml')} onClick={open} />}
        </span>
    );
}
