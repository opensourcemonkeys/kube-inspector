import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GroupActions from './GroupActions';

const openTerminal = vi.fn();
const openApplyYaml = vi.fn();
const setActive = vi.fn();

vi.mock('../../contexts/TabContext', () => ({
    useTabContext: () => ({ openTerminal, openApplyYaml }),
}));

let activeCluster = 'nav-cluster';

vi.mock('../../contexts/ClusterContext', () => ({
    useClusterContext: () => ({ activeCluster }),
}));

/**
 * dockview hands the header-actions component the *group* api, plus the panel
 * currently shown in that group. Only those two matter here; the rest of
 * IDockviewHeaderActionsProps is along for the ride.
 */
function mount(activePanelParams?: Record<string, unknown>) {
    return render(
        <GroupActions
            api={{ setActive } as any}
            activePanel={activePanelParams ? ({ params: activePanelParams } as any) : undefined}
            containerApi={{} as any}
            panels={[]}
            isGroupActive
            group={{} as any}
            headerPosition={'top' as any}
        />,
    );
}

function openDial() {
    fireEvent.click(screen.getByRole('button', { name: 'New panel' }));
}

// PrimeReact puts `role="menuitem"` on both the <li> and the <a> inside it, so
// a role query is ambiguous; only the anchor carries the aria-label.
function clickAction(label: string) {
    fireEvent.click(screen.getByLabelText(label));
}

beforeEach(() => {
    openTerminal.mockClear();
    openApplyYaml.mockClear();
    setActive.mockClear();
    activeCluster = 'nav-cluster';
});

describe('GroupActions', () => {
    it('opens a terminal pinned to the cluster selected in the nav panel', () => {
        mount({ clusterName: 'panel-cluster' });
        openDial();
        clickAction('Terminal');

        expect(openTerminal).toHaveBeenCalledWith('nav-cluster');
        expect(openApplyYaml).not.toHaveBeenCalled();
    });

    it('opens a yaml editor pinned to the cluster selected in the nav panel', () => {
        mount({ clusterName: 'panel-cluster' });
        openDial();
        clickAction('YAML Editor');

        expect(openApplyYaml).toHaveBeenCalledWith('nav-cluster');
        expect(openTerminal).not.toHaveBeenCalled();
    });

    // TabContext opens both panels with a bare `api.addPanel`, which lands them
    // in whichever group is *active*. Activating this group first is the only
    // thing that makes the "+" of a split layout open into its own group.
    it('activates its own group before opening, not after', () => {
        mount({ clusterName: 'panel-cluster' });
        openDial();
        clickAction('Terminal');

        expect(setActive).toHaveBeenCalled();
        expect(setActive.mock.invocationCallOrder[0])
            .toBeLessThan(openTerminal.mock.invocationCallOrder[0]);
    });

    // ClusterContext starts empty and fills in asynchronously, so the very first
    // frames have no nav selection to read.
    it('falls back to the active panel\'s cluster before the nav selection loads', () => {
        activeCluster = '';
        mount({ clusterName: 'panel-cluster' });
        openDial();
        clickAction('Terminal');

        expect(openTerminal).toHaveBeenCalledWith('panel-cluster');
    });

    it('passes an empty cluster when neither is known', () => {
        activeCluster = '';
        mount(undefined);
        openDial();
        clickAction('YAML Editor');

        expect(openApplyYaml).toHaveBeenCalledWith('');
    });
});
