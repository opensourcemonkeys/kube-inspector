import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { VscClose } from 'react-icons/vsc';
import { IDockviewPanelHeaderProps } from 'dockview';
import { useInstanceContext } from '../../contexts/InstanceContext';
import { useClusterColor } from '../../stores/clusterColorStore';
import InstancePickerMenu, { TabTarget } from '../transfer/InstancePickerMenu';
import { useT } from '../../i18n/useT';
import {
    PanelPayload,
    ShellWindow,
    endDragGhost,
    listWindows,
    sendPanelToWindow,
    startDragGhost,
    supportsWindows,
    undockPanel,
    windowAtCursor,
} from '../../lib/shellWindows';

// Live PTY sessions are bound to the process that opened them, and moving a
// panel re-creates it rather than reparenting the DOM — so these cannot travel.
const NON_TRANSFERABLE = new Set(['terminal', 'podExec', 'nodeShell']);

// How far the pointer must travel before a press counts as a drag rather than
// a click. Matches dockview's own default threshold.
const DRAG_THRESHOLD = 8;

function getComponentType(panelId: string): string {
    if (panelId.startsWith('yaml:')) return 'yamlEditor';
    if (panelId.startsWith('log:')) return 'logViewer';
    if (panelId.startsWith('exec:')) return 'podExec';
    if (panelId.startsWith('nodeshell:')) return 'nodeShell';
    if (panelId.startsWith('terminal-')) return 'terminal';
    if (panelId.startsWith('applyYaml:')) return 'applyYaml';
    if (panelId.startsWith('policy:')) return 'policyViewer';
    if (panelId.startsWith('configmap-editor:')) return 'configMapEditor';
    if (panelId.startsWith('secret-editor:')) return 'secretEditor';
    if (panelId.startsWith('role-editor:')) return 'roleEditor';
    if (panelId.startsWith('rolebinding-editor:')) return 'roleBindingEditor';
    if (panelId.startsWith('object-yaml:')) return 'objectYaml';
    if (panelId.startsWith('cluster-resource-view')) return 'clusterResource';
    return 'view';
}

export default function FloatableTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
    const t = useT();
    const { instances, selfInfo, transferTab } = useInstanceContext();
    const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
    const [siblingWindows, setSiblingWindows] = useState<ShellWindow[]>([]);
    const tabRef = useRef<HTMLDivElement>(null);

    const componentType = getComponentType(api.id);

    // --- Per-cluster accent --------------------------------------------------
    //
    // The accent stripe lives on dockview's own `.dv-tab` wrapper (it has
    // padding, so a stripe drawn inside our root would not span the tab), and
    // that element is two levels up: .dv-tab > .dv-react-part > our root. So we
    // hand it the colour as a custom property and let the stylesheet paint it.
    // Panels without a cluster (terminals) simply get no accent.
    const accent = useClusterColor((params as Record<string, any>)?.clusterName);

    // Which wrapper we last painted. Moving a panel gives us a different one,
    // and the stale wrapper has to be cleared by identity — resolving it again
    // at cleanup time would find the *new* one and strip its accent.
    const paintedRef = useRef<HTMLElement | null>(null);

    const paintAccent = useCallback(() => {
        const wrapper = tabRef.current?.closest('.dv-tab') as HTMLElement | null;
        const previous = paintedRef.current;
        if (previous && previous !== wrapper) previous.style.removeProperty('--tab-accent');
        paintedRef.current = wrapper;
        if (!wrapper) return;
        if (accent) wrapper.style.setProperty('--tab-accent', accent);
        else wrapper.style.removeProperty('--tab-accent');
    }, [accent]);

    useLayoutEffect(() => {
        paintAccent();

        // Moving a panel does NOT remount this component: dockview builds a
        // fresh `.dv-tab` and re-parents our existing element into it
        // (dockview-core Tabs.openPanel → Tab.setContent), while the panel's
        // tab renderer object is created once per panel and reused. The new
        // wrapper therefore carries no `--tab-accent` and the stylesheet falls
        // back to the theme's default stripe — the cluster's colour silently
        // turns into --teal on every split, reorder or drop into another group.
        //
        // Two signals are needed because neither covers the other's case:
        //  - onDidMovePanel fires *after* the re-parent, and is the only one
        //    raised for a reorder inside the same group (`api.group` is
        //    unchanged there, so no group event is emitted at all).
        //  - onDidGroupChange covers relocations that are not reported as a
        //    move — floating a panel with shift-drag — but it is fired from the
        //    `api.group` setter, i.e. *before* the new wrapper exists. The
        //    repaint is therefore deferred to a microtask: still inside the
        //    same task as the move, so nothing is painted in between.
        const subs = [
            containerApi.onDidMovePanel(e => {
                if (e.panel.id === api.id) paintAccent();
            }),
            api.onDidGroupChange(() => queueMicrotask(paintAccent)),
        ];

        return () => {
            subs.forEach(s => s.dispose());
            paintedRef.current?.style.removeProperty('--tab-accent');
            paintedRef.current = null;
        };
    }, [api, containerApi, paintAccent]);
    const canTransfer = !NON_TRANSFERABLE.has(componentType);
    const otherInstances = instances.filter(i => i.id !== selfInfo?.id);

    const serialize = useCallback((): PanelPayload => {
        const panel = containerApi.getPanel(api.id);
        const panelState = (panel as any)?.toJSON?.();
        const raw = (panel?.params ?? panelState?.params ?? {}) as Record<string, any>;

        // A view panel's params carry its sidebar icon as a React element
        // (TabContext.openTab). Electron IPC uses structured clone, which
        // throws outright on one — silently killing both the undock and the
        // drag-out path. The hub only tolerated it because JSON drops it.
        // Strip it and round-trip the rest so both transports get plain data;
        // the receiving window re-derives the icon from `view`.
        const { icon: _icon, ...rest } = raw;
        return {
            componentType,
            title: api.title ?? '',
            params: JSON.parse(JSON.stringify(rest)),
        };
    }, [api, containerApi, componentType]);

    // --- Drag a tab out of the window ---------------------------------------
    //
    // Dockview drives tab drags with pointer events (dndStrategy: 'pointer'),
    // so there is no dataTransfer to hand across a window boundary. Instead we
    // watch for a release *outside* this window's viewport, which dockview
    // ignores because no drop target was hit, and route the panel ourselves.
    //
    // The inside/outside test uses client coordinates against innerWidth/Height
    // — window-relative, so DPI scaling and Wayland cannot skew it. Where the
    // pointer actually landed is resolved in the main process instead.
    useEffect(() => {
        if (!canTransfer || !supportsWindows()) return;

        const el = tabRef.current;
        if (!el) return;

        let startX = 0;
        let startY = 0;
        let pointerId: number | null = null;
        let dragging = false;

        const detach = () => {
            pointerId = null;
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onCancel, true);
        };

        // Ends the OS-level ghost AND (in main) sends the target window its
        // final dragLeave. Must run only after any panel has been dispatched,
        // or the target clears its overlay before the drop lands.
        const onCancel = () => {
            detach();
            if (dragging) { dragging = false; endDragGhost(); }
        };

        // Once the press turns into a real drag, hand the shell an OS-level
        // ghost. It stays hidden until the pointer leaves this window, so it
        // simply takes over where dockview's own clipped ghost stops.
        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerId !== pointerId || dragging) return;
            if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
            dragging = true;
            startDragGhost(api.title ?? '');
        };

        const onPointerUp = async (e: PointerEvent) => {
            if (e.pointerId !== pointerId) return;
            const wasDragging = dragging;
            const movedFar = wasDragging ||
                Math.hypot(e.clientX - startX, e.clientY - startY) >= DRAG_THRESHOLD;
            detach();

            const endGhost = () => { if (wasDragging) endDragGhost(); dragging = false; };

            const outside =
                e.clientX < 0 || e.clientY < 0 ||
                e.clientX > window.innerWidth || e.clientY > window.innerHeight;
            // dockview handles in-window rearranging; only an outside release is ours.
            if (!movedFar || !outside) { endGhost(); return; }

            const panel = serialize();
            const targetWindow = await windowAtCursor();
            if (targetWindow !== null) {
                // Moving onto an existing window is allowed even for the last
                // tab — it consolidates rather than spawning a window. Send the
                // panel BEFORE ending the ghost: the target places it using the
                // live overlay, which the ghost-end tears down.
                sendPanelToWindow(targetWindow, panel);
                api.close();
            } else if (containerApi.totalPanels > 1) {
                // Undocking the only tab would just relocate the same window,
                // leaving nothing behind — so it is a no-op here.
                undockPanel(panel);
                api.close();
            }
            endGhost();
        };

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0) return;
            startX = e.clientX;
            startY = e.clientY;
            pointerId = e.pointerId;
            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', onPointerUp, true);
            window.addEventListener('pointercancel', onCancel, true);
        };

        el.addEventListener('pointerdown', onPointerDown);
        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            onCancel();
        };
    }, [api, canTransfer, serialize]);

    // --- Middle-click close -------------------------------------------------
    //
    // The close fires on auxclick (a completed press+release on the tab), not
    // mousedown, so dragging away after a middle press does not close it.
    // mousedown still needs preventDefault to suppress Chromium's autoscroll.

    const handleAuxDown = (e: React.MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
    };

    const handleAuxClick = (e: React.MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        api.close();
    };

    // --- Right-click menu ---------------------------------------------------

    const handleContextMenu = async (e: React.MouseEvent) => {
        if (!canTransfer) return;
        e.preventDefault();
        e.stopPropagation();
        setSiblingWindows(await listWindows());
        setMenuPos({ x: e.clientX, y: e.clientY });
    };

    const handleSelect = async (target: TabTarget) => {
        const panel = serialize();
        switch (target.kind) {
            case 'undock':
                undockPanel(panel);
                break;
            case 'window':
                sendPanelToWindow(target.id, panel);
                break;
            case 'instance':
                await transferTab(target.id, panel as any);
                break;
        }
        api.close();
    };

    // Undock is hidden for a lone tab: opening it in a new window would just
    // move this window's only panel, emptying the source.
    const canUndock = supportsWindows() && containerApi.totalPanels > 1;

    const targets: TabTarget[] = [
        ...(canUndock ? [{ kind: 'undock' } as TabTarget] : []),
        ...siblingWindows.map(w => ({ kind: 'window' as const, id: w.id, label: `Pencere ${w.id}` })),
        ...otherInstances.map(i => ({ kind: 'instance' as const, id: i.id, label: i.name })),
    ];

    return (
        <div
            ref={tabRef}
            onContextMenu={handleContextMenu}
            onMouseDown={handleAuxDown}
            onAuxClick={handleAuxClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                padding: '0 2px 0 8px',
                gap: 4,
                userSelect: 'none',
                cursor: 'default',
            }}
        >
            <span
                // Clipped at 180px since long before i18n; the tooltip is what
                // makes that survivable once the label is German or Russian.
                title={api.title}
                style={{
                    fontSize: 12,
                    color: 'var(--dv-tab-color, inherit)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 180,
                    flex: 1,
                }}
            >
                {api.title}
            </span>

            <button
                title={t('panels:tabMenu.close')}
                onClick={e => { e.stopPropagation(); api.close(); }}
                style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 3px',
                    borderRadius: 3,
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--dv-tab-color, var(--ink2))',
                    opacity: 0,
                    flexShrink: 0,
                    transition: 'opacity 0.15s',
                }}
                className="tab-close-btn"
            >
                <VscClose size={13} />
            </button>

            {menuPos && (
                <InstancePickerMenu
                    targets={targets}
                    position={menuPos}
                    onSelect={handleSelect}
                    onClose={() => setMenuPos(null)}
                />
            )}
        </div>
    );
}
