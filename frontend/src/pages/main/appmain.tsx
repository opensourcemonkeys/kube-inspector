import { useState, useRef, useMemo } from 'react';
import { NextStepProvider, NextStepReact } from 'nextstepjs';
import SideMenu from '../../components/menu/menu';
import TitleBar from '../../components/titlebar/TitleBar';
import DockviewContainer from '../../components/workspace/DockviewContainer';
import TabInstanceBridge from '../../components/workspace/TabInstanceBridge';
import ClusterBar from '../../components/cluster/ClusterBar';
import AiChat from '../../components/ai/AiChat';
import CliModeOverlay from '../../components/climode/CliModeOverlay';
import { TabProvider } from '../../contexts/TabContext';
import { ClusterProvider } from '../../contexts/ClusterContext';
import { InstanceProvider } from '../../contexts/InstanceContext';
import { buildAppTour } from '../../lib/tourSteps';
import { useT } from '../../i18n/useT';
import TourCard from '../../components/tour/TourCard';
import { isPrimaryWindow } from '../../lib/shellWindows';
import PanelErrorBoundary from '../../components/shared/PanelErrorBoundary';

const SIDEBAR_OPEN_KEY = 'kube-sidebar-open';

function Appmain() {
    const t = useT();
    // nextstepjs snapshots the step text when a tour starts, so rebuild it
    // whenever the language changes.
    const tour = useMemo(() => buildAppTour(t), [t]);

    // Windows opened by undocking/dragging out a tab start with the menu
    // collapsed — they exist to show that one panel, not to browse. Only the
    // primary window restores (and persists) the saved preference; a secondary
    // window shares the same origin's localStorage, so persisting its toggle
    // would clobber the primary's choice.
    const [sidebarOpen, setSidebarOpen] = useState(() =>
        isPrimaryWindow() && localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false'
    );
    const [hovered, setHovered] = useState(false);
    const [cliMode, setCliMode] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const toggleSidebar = () => {
        setSidebarOpen(prev => {
            if (isPrimaryWindow()) localStorage.setItem(SIDEBAR_OPEN_KEY, String(!prev));
            return !prev;
        });
    };

    const onEnter = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setHovered(true);
    };

    const onLeave = () => {
        closeTimer.current = setTimeout(() => setHovered(false), 250);
    };

    return (
        // Outermost boundary: the per-panel ones cover the workspace, this one
        // covers everything around it (providers, title bar, sidebar). A crash
        // here still leaves a window that can be reloaded and a report that can
        // be copied, instead of a blank one.
        // `label` is the crash's diagnostics id, not display text.
        // eslint-disable-next-line i18next/no-literal-string
        <PanelErrorBoundary label="app" root>
        <NextStepProvider>
            <NextStepReact
                steps={tour}
                shadowRgb="0, 0, 0"
                shadowOpacity="0.55"
                cardTransition={{
                    type: 'spring',
                    stiffness: 300,
                    damping: 20
                }}
                cardComponent={TourCard}
                scrollToTop={false}
                disableConsoleLogs
            >
                <ClusterProvider>
                    <InstanceProvider>
                    <TabProvider>
                        <TabInstanceBridge />
                        <AiChat />
                        <div className="flex flex-column overflow-hidden" style={{ height: '100vh' }}>
                            <TitleBar onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} onToggleCli={() => setCliMode(true)} />
                            <div className="flex-1 min-h-0 relative overflow-hidden">

                                {/* CLI mode: fullscreen terminal UI over the workspace. Dockview +
                                    menu stay mounted underneath so their state survives the toggle. */}
                                {cliMode && <CliModeOverlay onClose={() => setCliMode(false)} />}

                                {/* Hover trigger zone — only active when sidebar is collapsed */}
                                {!sidebarOpen && <div className="app-sidebar-hotzone" onMouseEnter={onEnter} />}

                                {/* Resource Explorer Sidebar — always absolute so it never affects workspace layout */}
                                <div
                                    className={`app-sidebar${sidebarOpen ? ' app-sidebar--docked' : hovered ? ' app-sidebar--floating' : ''}`}
                                    onMouseEnter={onEnter}
                                    onMouseLeave={onLeave}
                                >
                                    <ClusterBar />
                                    <SideMenu />
                                </div>

                                {/* Main Workspace — shifts right only when sidebar is open */}
                                <div
                                    id="tour-workspace"
                                    className={`app-workspace${sidebarOpen ? ' app-workspace--beside-sidebar' : ''}`}
                                >
                                    <DockviewContainer />
                                </div>
                            </div>
                        </div>
                    </TabProvider>
                    </InstanceProvider>
                </ClusterProvider>
            </NextStepReact>
        </NextStepProvider>
        </PanelErrorBoundary>
    );
}

export default Appmain;
