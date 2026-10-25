import { useState, useEffect, useRef } from 'react';
import {
    VscAdd, VscEdit,
    VscTypeHierarchySub, VscTools, VscWarning,
} from 'react-icons/vsc';
import { Dropdown } from 'primereact/dropdown';
import { OverlayPanel } from 'primereact/overlaypanel';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useTabContext } from '../../contexts/TabContext';
import { defaultColorId, hexForId } from '../../lib/clusterColors';
import { useClusterColorStore } from '../../stores/clusterColorStore';
import ClusterModal from './ClusterModal';
import StatusLamp from '../shared/StatusLamp';
import { useT } from '../../i18n/useT';

export default function ClusterBar() {
    const t = useT();
    const { clusters, activeCluster, loaded, connectionError, refreshClusters, selectCluster } = useClusterContext();
    const { openClusterResourceView, openToolbox } = useTabContext();
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCluster, setEditingCluster] = useState<string | null>(null);
    const initialCheckDone = useRef(false);
    const errorPanelRef = useRef<OverlayPanel>(null);

    const overrides = useClusterColorStore(s => s.overrides);

    const colorOf = (name: string) => hexForId(overrides[name] ?? defaultColorId(name));
    const activeColor = activeCluster ? colorOf(activeCluster) : null;

    // Publish the active cluster's colour app-wide so the sidebar accent can
    // pick it up. Deliberately a different variable from the tabs' --tab-accent
    // (FloatableTab), which is set per tab element — a shared name would leak
    // this colour into panels that carry no cluster.
    useEffect(() => {
        const el = document.documentElement;
        if (activeColor) el.style.setProperty('--cluster-accent', activeColor);
        else el.style.removeProperty('--cluster-accent');
    }, [activeColor]);

    useEffect(() => {
        if (!loaded || initialCheckDone.current) return;
        initialCheckDone.current = true;
        if (clusters.length === 0) {
            setEditingCluster(null);
            setModalOpen(true);
        }
    }, [loaded, clusters]);

    const openAdd = () => { setEditingCluster(null); setModalOpen(true); };
    const openEdit = () => { if (!activeCluster) return; setEditingCluster(activeCluster); setModalOpen(true); };
    const handleClose = () => { setModalOpen(false); setEditingCluster(null); };
    const handleSaved = async (name: string) => {
        await refreshClusters();
        await selectCluster(name);
        handleClose();
    };

    const isOk = !connectionError;

    // The dot carries the cluster's colour identity. Connection health is not
    // lost: on error the dot dims and gains a red ring, and the status key
    // in the actions row appears alongside it. The colour is the only inline
    // value — it is per cluster, so it rides a custom property.
    const clusterValueTemplate = (value: string) => {
        if (!value) return <span className="cluster-value cluster-value--empty">{t('panels:cluster.select')}</span>;
        return (
            <span className={`cluster-value${isOk ? '' : ' cluster-value--down'}`} style={{ ['--dot' as string]: colorOf(value) }}>
                <span className="cluster-value__dot" />
                <span className="cluster-value__name">{value}</span>
            </span>
        );
    };

    // Colours are edited in ClusterModal; the dropdown only displays them.
    const clusterItemTemplate = (value: string) => {
        const color = colorOf(value);
        return (
            <div className="cluster-option">
                <span className="cluster-option__bullet" style={{ ['--dot' as string]: color }} />
                <span className="cluster-option__name">{value}</span>
            </div>
        );
    };

    return (
        <>
            <div id="tour-cluster-area" className="cluster-header">
                <Dropdown
                    value={activeCluster || null}
                    options={clusters}
                    onChange={e => selectCluster(e.value)}
                    placeholder={t('panels:cluster.select')}
                    className="cluster-header__dropdown"
                    emptyMessage={t('panels:cluster.none')}
                    valueTemplate={clusterValueTemplate}
                    itemTemplate={clusterItemTemplate}
                />

                <div className="cluster-header__actions">
                    <button className="cluster-header__icon-btn" onClick={openAdd} title={t('panels:cluster.add')}>
                        <VscAdd size={14} />
                    </button>
                    {activeCluster && (
                        <>
                            <button className="cluster-header__icon-btn" onClick={openEdit} title={t('panels:cluster.edit')}>
                                <VscEdit size={14} />
                            </button>
                            <button className="cluster-header__icon-btn" onClick={() => openClusterResourceView(activeCluster)} title={t('panels:cluster.graph')}>
                                <VscTypeHierarchySub size={14} />
                            </button>
                            <button className="cluster-header__icon-btn" onClick={() => openToolbox(activeCluster)} title={t('panels:cluster.toolbox')}>
                                <VscTools size={14} />
                            </button>
                        </>
                    )}
                    {connectionError && (
                        <>
                            {/* A steady lamp and words, not a pulsing icon: a
                                broken connection is a state to read, not an
                                alarm to chase. Click for the error itself. */}
                            <button
                                className="cluster-header__status"
                                onClick={e => errorPanelRef.current?.toggle(e)}
                                aria-haspopup="dialog"
                            >
                                <StatusLamp label={t('panels:cluster.connectionErrorTitle')} tone="err" />
                            </button>
                            <OverlayPanel ref={errorPanelRef} className="cluster-error-panel">
                                <div className="cluster-error-panel__header">
                                    <VscWarning className="cluster-error-panel__icon" size={16} />
                                    <span>{t('panels:cluster.connectionError')}</span>
                                </div>
                                <pre className="cluster-error-panel__detail">{connectionError}</pre>
                            </OverlayPanel>
                        </>
                    )}
                </div>
            </div>

            {modalOpen && (
                <ClusterModal
                    editingName={editingCluster}
                    onClose={handleClose}
                    onSaved={handleSaved}
                    dismissible={clusters.length > 0}
                />
            )}
        </>
    );
}
