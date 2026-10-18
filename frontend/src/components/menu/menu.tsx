import { useState, useEffect } from 'react';
import { VscChevronDown } from 'react-icons/vsc';
import { useTabContext } from '../../contexts/TabContext';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useActiveViewStore } from '../../stores/activeViewStore';
import { NAV_GROUPS, VIEW_GROUP, HOME_ITEM, NavItem } from './menuItems';
import { useT } from '../../i18n/useT';

const SIDEBAR_STATE_KEY = 'kube-sidebar-state';

export default function SideMenu() {
    const t = useT();
    const { openTab } = useTabContext();
    const { activeCluster } = useClusterContext();
    // The focused panel's view, not the last item clicked here: switching tabs,
    // closing one, or a panel arriving from another window all move it.
    const activeView = useActiveViewStore((s) => s.view);
    const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(SIDEBAR_STATE_KEY) ?? '{}');
            return Object.keys(saved).length > 0 ? saved : { workloads: true };
        } catch { return { workloads: true }; }
    });

    const navigate = (item: NavItem) => {
        // No title: openTab resolves it from the view so the tab re-labels itself
        // when the language changes (see TabContext).
        openTab({ view: item.view, clusterName: activeCluster, icon: item.icon });
    };

    const toggleGroup = (key: string) => {
        setExpanded(prev => {
            const next = { ...prev, [key]: !prev[key] };
            localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(next));
            return next;
        });
    };

    // Reveal the active item when its group is collapsed — otherwise focusing a
    // tab could mark an item nobody can see.
    useEffect(() => {
        const grp = activeView ? VIEW_GROUP[activeView] : undefined;
        if (!grp) return;
        setExpanded(prev => {
            if (prev[grp]) return prev;
            const next = { ...prev, [grp]: true };
            localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(next));
            return next;
        });
    }, [activeView]);

    const itemButton = (item: NavItem) => {
        const active = activeView === item.view;
        return (
            <button
                key={item.view}
                className={`sidebar-item${active ? ' sidebar-item--active' : ''}`}
                onClick={() => navigate(item)}
                title={t(item.labelKey)}
                aria-current={active ? 'page' : undefined}
            >
                <span className="sidebar-item__icon">{item.icon}</span>
                <span className="sidebar-item__label">{t(item.labelKey)}</span>
            </button>
        );
    };

    return (
        <nav id="tour-sidebar" className="sidebar-nav">
            <div className="sidebar-home">{itemButton(HOME_ITEM)}</div>
            {NAV_GROUPS.map(group => {
                // Always a boolean: a group never opened has no entry, and an
                // undefined aria-expanded drops the attribute, so a screen
                // reader was never told the group could be expanded.
                const open = !!expanded[group.key];
                return (
                    <div key={group.key} className="sidebar-section">
                        <button
                            className="sidebar-section__toggle"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={open}
                        >
                            <VscChevronDown
                                className={`sidebar-section__chevron${open ? '' : ' sidebar-section__chevron--closed'}`}
                                size={12}
                            />
                            <span className="sidebar-section__badge-label">{t(group.labelKey)}</span>
                        </button>
                        {open && (
                            <div className="sidebar-section__items">
                                {group.items.map(itemButton)}
                            </div>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}
