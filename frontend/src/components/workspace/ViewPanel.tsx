import { lazy } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { useT } from '../../i18n/useT';

/**
 * Routes a `view` panel to the resource view it names.
 *
 * Every view is `React.lazy`. They are cheap individually but there are ~30 of
 * them, and between them they pull in chart.js (monitoring, nodes, quotas),
 * reactflow (the security role map) and the Trivy scanner UI — all of which
 * used to be parsed at launch for a session that only ever looks at Pods.
 * Suspense is supplied by `withBoundary` in DockviewContainer, which wraps this
 * component, so a view's chunk loading is already covered.
 */
const DataTableComponent = lazy(() => import('../pod/main'));
const DeploymentListComponent = lazy(() => import('../deployment/main'));
const StatefulSetListComponent = lazy(() => import('../statefulset/main'));
const ReplicaSetListComponent = lazy(() => import('../replicaset/main'));
const DaemonSetListComponent = lazy(() => import('../daemonset/main'));
const JobListComponent = lazy(() => import('../job/main'));
const CronJobListComponent = lazy(() => import('../cronjob/main'));
const ServiceListComponent = lazy(() => import('../service/main'));
const IngressListComponent = lazy(() => import('../ingress/main'));
const IngressClassListComponent = lazy(() => import('../ingressclass/main'));
const EndpointListComponent = lazy(() => import('../endpoints/main'));
const NetworkPolicyListComponent = lazy(() => import('../networkpolicy/main'));
const ConfigMapListComponent = lazy(() => import('../configmap/main'));
const SecretListComponent = lazy(() => import('../secret/main'));
const NodeListComponent = lazy(() => import('../node/main'));
const NamespaceListComponent = lazy(() => import('../namespace/main'));
const ResourceQuotaListComponent = lazy(() => import('../resourcequota/main'));
const EventListComponent = lazy(() => import('../events/main'));
const LimitRangeListComponent = lazy(() => import('../limitrange/main'));
const PersistentVolumeListComponent = lazy(() => import('../persistentvolume/main'));
const PersistentVolumeClaimListComponent = lazy(() => import('../persistentvolumeclaim/main'));
const StorageClassListComponent = lazy(() => import('../storageclass/main'));
const ServiceAccountListComponent = lazy(() => import('../serviceaccount/main'));
const RoleListComponent = lazy(() => import('../role/main'));
const RoleBindingListComponent = lazy(() => import('../rolebinding/main'));
const SecurityRoleMap = lazy(() => import('../security/SecurityRoleMap'));
const TrivyScanner = lazy(() => import('../security/trivy/TrivyScanner'));
const MonitoringDashboard = lazy(() => import('../monitoring/main'));
const OverviewDashboard = lazy(() => import('../overview/main'));
const CrdListComponent = lazy(() => import('../crd/main'));
interface ViewPanelParams {
    view: string;
    clusterName: string;
}

export default function ViewPanel({ params, api }: IDockviewPanelProps<ViewPanelParams>) {
    const t = useT();
    const { view, clusterName } = params;
    const cn = clusterName ?? '';

    if (view === 'pods') return <DataTableComponent clusterName={cn} api={api} />;
    if (view === 'deployments') return <DeploymentListComponent clusterName={cn} api={api} />;
    if (view === 'statefulsets') return <StatefulSetListComponent clusterName={cn} api={api} />;
    if (view === 'replicasets') return <ReplicaSetListComponent clusterName={cn} api={api} />;
    if (view === 'daemonsets') return <DaemonSetListComponent clusterName={cn} api={api} />;
    if (view === 'jobs') return <JobListComponent clusterName={cn} api={api} />;
    if (view === 'cronjobs') return <CronJobListComponent clusterName={cn} api={api} />;
    if (view === 'services') return <ServiceListComponent clusterName={cn} api={api} />;
    if (view === 'ingresses') return <IngressListComponent clusterName={cn} api={api} />;
    if (view === 'ingressclasses') return <IngressClassListComponent clusterName={cn} api={api} />;
    if (view === 'endpoints') return <EndpointListComponent clusterName={cn} api={api} />;
    if (view === 'networkpolicies') return <NetworkPolicyListComponent clusterName={cn} api={api} />;
    if (view === 'configmaps') return <ConfigMapListComponent clusterName={cn} api={api} />;
    if (view === 'secrets') return <SecretListComponent clusterName={cn} api={api} />;
    if (view === 'nodes') return <NodeListComponent clusterName={cn} api={api} />;
    if (view === 'namespaces') return <NamespaceListComponent clusterName={cn} api={api} />;
    if (view === 'events') return <EventListComponent clusterName={cn} api={api} />;
    if (view === 'resourcequotas') return <ResourceQuotaListComponent clusterName={cn} api={api} />;
    if (view === 'limitranges') return <LimitRangeListComponent clusterName={cn} api={api} />;
    if (view === 'persistentvolumes') return <PersistentVolumeListComponent clusterName={cn} api={api} />;
    if (view === 'persistentvolumeclaims') return <PersistentVolumeClaimListComponent clusterName={cn} api={api} />;
    if (view === 'storageclasses') return <StorageClassListComponent clusterName={cn} api={api} />;
    if (view === 'serviceaccounts') return <ServiceAccountListComponent clusterName={cn} api={api} />;
    if (view === 'roles') return <RoleListComponent clusterName={cn} api={api} />;
    if (view === 'rolebindings') return <RoleBindingListComponent clusterName={cn} api={api} />;
    if (view === 'securityrolemap') return <SecurityRoleMap clusterName={cn} />;
    if (view === 'trivy') return <TrivyScanner clusterName={cn} />;
    if (view === 'monitoring') return <MonitoringDashboard clusterName={cn} api={api} />;
    if (view === 'overview') return <OverviewDashboard clusterName={cn} api={api} />;
    if (view === 'crds') return <CrdListComponent clusterName={cn} api={api} />;

    return (
        <div className="card p-4">
            <h2 className="mt-0 mb-2">{view}</h2>
            <p className="m-0 text-color-secondary">{t('panels:viewPanel.notConnected')}</p>
        </div>
    );
}
