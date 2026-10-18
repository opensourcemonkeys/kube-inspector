import { useCallback, useEffect, useState } from 'react';
import { VscChromeMinimize, VscChromeMaximize, VscChromeRestore, VscChromeClose, VscCloudUpload, VscCloudDownload, VscTerminal, VscQuestion, VscInfo, VscHubot, VscLayoutSidebarLeft, VscCheck, VscSymbolColor, VscScreenFull, VscPulse, VscArrowSwap, VscGlobe } from 'react-icons/vsc';
import { Menubar } from 'primereact/menubar';
import { MenuItem } from 'primereact/menuitem';
import {
    WindowMinimise,
    WindowToggleMaximise,
    Quit,
    BrowserOpenURL,
} from '../../../wailsjs/runtime/runtime';
import { CheckForUpdate, SetUpdateChannel } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useAiChatStore } from '../../stores/aiChatStore';
import { useThemeStore, THEMES } from '../../stores/themeStore';
import { useLocaleStore, LOCALES } from '../../stores/localeStore';
import { useT } from '../../i18n/useT';
import StatusLamp from '../shared/StatusLamp';
import { useNextStep } from 'nextstepjs';
import AboutModal from '../cluster/AboutModal';
import UpdateModal from './UpdateModal';
import PortForwardPill from './PortForwardPill';

// Re-check for a newer release every 6 hours while the app stays open.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Where a wrong translation gets reported (docs page carries the issue template link).
const TRANSLATIONS_URL = 'https://kubeinspector.com/contributing/translations/';

interface TitleBarProps {
    onToggleSidebar?: () => void;
    sidebarOpen?: boolean;
    onToggleCli?: () => void;
}

function TitleBar({ onToggleSidebar, sidebarOpen = true, onToggleCli }: TitleBarProps) {
    const [maximised, setMaximised] = useState(false);
    const [aboutOpen, setAboutOpen] = useState(false);
    const [updateOpen, setUpdateOpen] = useState(false);
    const [update, setUpdate] = useState<models.UpdateInfo | null>(null);
    // Latched. The backend reports a failed update exactly once — the record is
    // read and cleared — so a later 6-hourly re-check comes back with the field
    // empty and would otherwise pull the notice out from under the user.
    const [failedUpdate, setFailedUpdate] = useState('');
    const { openTerminal, openApplyYaml, openDiagnostics, openPortForwards } = useTabContext();
    const { activeCluster } = useClusterContext();
    const { startNextStep } = useNextStep();
    const toggleAi = useAiChatStore((s) => s.toggle);
    const aiOpen = useAiChatStore((s) => s.open);
    const theme = useThemeStore((s) => s.theme);
    const setTheme = useThemeStore((s) => s.setTheme);
    const locale = useLocaleStore((s) => s.locale);
    const setLocale = useLocaleStore((s) => s.setLocale);
    const t = useT();

    // Hoisted out of the effect so the interval, the Help menu's "Check for
    // updates" item and the channel switcher all run the same check.
    const check = useCallback(
        () =>
            CheckForUpdate()
                .then((u) => {
                    setUpdate(u);
                    if (u.failedUpdateVersion) setFailedUpdate(u.failedUpdateVersion);
                })
                .catch(() => { /* offline: ignore */ }),
        [],
    );

    // Switching channel re-checks immediately: the manifest it reads is a
    // different file, so the answer can change without any release happening.
    const switchChannel = useCallback(
        (channel: string) => {
            SetUpdateChannel(channel).then(check).catch(() => { /* ignore */ });
        },
        [check],
    );

    useEffect(() => {
        check();
        const id = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [check]);

    // Under a shell that reports real window state (Electron), subscribe to it
    // so the restore icon cannot desync from OS-initiated maximise/snap. Wails
    // and the browser have no such feed and keep the optimistic toggle below.
    const shell = (window as any).__KUBE_INS_SHELL__;
    useEffect(() => {
        if (!shell?.onMaximised) return;
        shell.isMaximised().then(setMaximised);
        return shell.onMaximised(setMaximised);
    }, []);

    const handleMaximise = () => {
        WindowToggleMaximise();
        if (!shell?.onMaximised) setMaximised(m => !m);
    };

    const menuModel: MenuItem[] = [
        {
            label: t('nav:menu.open'),
            items: [
                { label: t('nav:menu.yamlEditor'), icon: <VscCloudUpload size={13} />, command: () => openApplyYaml(activeCluster) },
                { label: t('nav:menu.terminal'),   icon: <VscTerminal size={13} />,    command: () => openTerminal(activeCluster) },
                { label: t('nav:menu.cliMode'),    icon: <VscScreenFull size={13} />,  command: () => onToggleCli?.() },
                { label: t('nav:menu.portForwards'), icon: <VscArrowSwap size={13} />, command: () => openPortForwards() },
                { separator: true },
                {
                    label: t('nav:menu.aiAssistant'),
                    icon: <VscHubot size={13} />,
                    className: aiOpen ? 'tb-menu-active' : undefined,
                    command: () => toggleAi(),
                },
                {
                    label: t('settings:theme.label'),
                    icon: <VscSymbolColor size={13} />,
                    // Theme and locale names are proper nouns / endonyms — they
                    // are the same in every catalog and stay out of i18n.
                    items: THEMES.map((th) => ({
                        label: th.label,
                        icon: th.id === theme ? <VscCheck size={13} /> : undefined,
                        command: () => setTheme(th.id),
                    })),
                },
                {
                    label: t('settings:language.label'),
                    icon: <VscGlobe size={13} />,
                    items: [
                        ...LOCALES.map((l) => ({
                            label: l.label,
                            icon: l.id === locale ? <VscCheck size={13} /> : undefined,
                            command: () => setLocale(l.id),
                        })),
                        { separator: true },
                        // Honesty note: only `tr` was reviewed by a native speaker;
                        // the other four are machine translations. Saying so here —
                        // where the language is chosen — is what makes the README's
                        // status table reach the person who can act on it.
                        {
                            label: t('settings:language.mtNote'),
                            className: 'tb-menu-note',
                            command: () => BrowserOpenURL(TRANSLATIONS_URL),
                        },
                    ],
                },
                {
                    // Here rather than in UpdateModal, which only opens when
                    // there is something to install — invisible in exactly the
                    // state where you would want to change channel. Theme and
                    // language, the app's only other preferences, live here too.
                    label: t('settings:updateChannel.label'),
                    icon: <VscCloudDownload size={13} />,
                    items: [
                        {
                            label: t('settings:updateChannel.stable'),
                            icon: update?.channel === 'stable' ? <VscCheck size={13} /> : undefined,
                            command: () => switchChannel('stable'),
                        },
                        {
                            label: t('settings:updateChannel.beta'),
                            icon: update?.channel === 'beta' ? <VscCheck size={13} /> : undefined,
                            command: () => switchChannel('beta'),
                        },
                        { separator: true },
                        {
                            // Switching beta -> stable never downgrades. Say so
                            // where the switch is made, or the user is left
                            // wondering why nothing happened.
                            label: update?.aheadOfChannel
                                ? t('settings:updateChannel.aheadNote')
                                : t('settings:updateChannel.betaHint'),
                            className: 'tb-menu-note',
                        },
                    ],
                },
            ],
        },
        {
            label: t('nav:menu.help'),
            items: [
                {
                    label: t('nav:menu.checkForUpdates'),
                    icon: <VscCloudDownload size={13} />,
                    command: () => { check(); setUpdateOpen(true); },
                },
                { separator: true },
                { label: t('nav:menu.tutorial'),    icon: <VscQuestion size={13} />, command: () => startNextStep('main') },
                { label: t('nav:menu.diagnostics'), icon: <VscPulse size={13} />,    command: () => openDiagnostics() },
                { label: t('nav:menu.about'),       icon: <VscInfo size={13} />,     command: () => setAboutOpen(true) },
            ],
        },
    ];

    return (
        <>
            <div className="tb-root">
                {/* Sidebar toggle (far left) */}
                <button
                    className="tb-sidebar-toggle"
                    onClick={onToggleSidebar}
                    title={sidebarOpen ? t('nav:window.collapseSidebar') : t('nav:window.expandSidebar')}
                >
                    <VscLayoutSidebarLeft size={14} />
                </button>

                {/* Logo + title (fixed left) */}
                <div className="tb-brand">
                    <svg className="tb-logo" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 2.5 L20 7 V17 L12 21.5 L4 17 V7 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                        <path d="M12 12 V21.5 M4 7 L12 12 L20 7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.7"/>
                        <circle cx="12" cy="8.6" r="1.7" fill="currentColor"/>
                    </svg>
                    {/* The product name, set as a wordmark — not tracked-out capitals. */}
                    <span className="tb-title">Kube Inspector</span>
                </div>

                {/* Menu bar (left, after logo). PrimeReact 10.9.7 has no
                    `breakpoint` prop; its theme collapses this to a hamburger
                    below a 960px viewport. The tb-actions rules in
                    theme-monolith.css neutralise that so the two-item bar stays
                    horizontal at any width. */}
                <div className="tb-actions">
                    <Menubar model={menuModel} />
                </div>

                {/* Draggable spacer */}
                <div
                    className="tb-drag"
                    role="button"
                    aria-label={t('nav:window.dragHint')}
                    tabIndex={0}
                    onDoubleClick={handleMaximise}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMaximise(); } }}
                />

                {/* Active tunnels (top-right, left of the update pill). Renders
                    nothing when there are none. */}
                <PortForwardPill onOpenPanel={openPortForwards} />

                {/* An update that was handed to an installer and did not take.
                    Suppressed while a newer one is on offer: the fix is to
                    install that, not to read about the last failure. */}
                {failedUpdate && !update?.available && (
                    <button
                        className="tb-update tb-update--warn"
                        title={t('nav:window.updateFailed')}
                        onClick={() => setUpdateOpen(true)}
                    >
                        <StatusLamp label={t('nav:window.updateFailed')} tone="warn" />
                    </button>
                )}

                {/* Update available (top-right, before window controls) */}
                {update?.available && (
                    <button
                        className="tb-update"
                        title={t('nav:window.updateTooltip', { version: update.latestVersion })}
                        onClick={() => setUpdateOpen(true)}
                    >
                        <span className="tb-update__mark" aria-hidden="true" />
                        {t('nav:window.updateAvailable')}
                    </button>
                )}

                {/* Window controls */}
                <div className="tb-controls">
                    <button className="tb-btn tb-btn--min" onClick={WindowMinimise} title={t('nav:window.minimise')}>
                        <VscChromeMinimize size={12} />
                    </button>

                    <button className="tb-btn tb-btn--max" onClick={handleMaximise} title={maximised ? t('nav:window.restore') : t('nav:window.maximise')}>
                        {maximised ? <VscChromeRestore size={12} /> : <VscChromeMaximize size={12} />}
                    </button>

                    <button className="tb-btn tb-btn--close" onClick={Quit} title={t('nav:window.close')}>
                        <VscChromeClose size={12} />
                    </button>
                </div>
            </div>

            <AboutModal visible={aboutOpen} onHide={() => setAboutOpen(false)} onDiagnostics={openDiagnostics} />

            {/* Mounted whenever a check has returned, not only when an update is
                available: it is also the "you're up to date", "ahead of this
                channel" and "the last update did not apply" surface. */}
            {update && (
                <UpdateModal visible={updateOpen} onHide={() => setUpdateOpen(false)} info={update} />
            )}
        </>
    );
}

export default TitleBar;
