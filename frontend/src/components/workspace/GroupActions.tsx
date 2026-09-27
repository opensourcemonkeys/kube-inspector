import { useMemo } from 'react';
import { VscAdd, VscChromeClose, VscCloudUpload, VscTerminal } from 'react-icons/vsc';
import { IDockviewHeaderActionsProps } from 'dockview';
import { SpeedDial } from 'primereact/speeddial';
import { useTabContext } from '../../contexts/TabContext';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useClusterColor } from '../../stores/clusterColorStore';
import { useT } from '../../i18n/useT';

/**
 * The "+" that sits immediately after the last tab of every group, registered
 * as dockview's `leftHeaderActionsComponent` (its header runs tabs → left
 * actions → void strip → right actions). Opens the two panels that are not tied
 * to a particular resource — a terminal and a blank YAML editor — the same pair
 * the title bar's Open menu offers.
 *
 * It is rendered per *group*, not once per window, which is the point: in a
 * split layout the panel lands in the tab bar that was clicked.
 */
export default function GroupActions({ api, activePanel }: IDockviewHeaderActionsProps) {
    const t = useT();
    const { openTerminal, openApplyYaml } = useTabContext();
    const { activeCluster } = useClusterContext();

    // The cluster picked in the nav panel's ClusterBar wins: these two panels
    // are the ones a user reaches for to act on "the cluster I am working on",
    // not on whatever the tab underneath happens to be pinned to. The active
    // panel's own cluster is only a fallback, for the first frames before
    // ClusterContext has loaded its selection.
    const clusterName = activeCluster
        || (activePanel?.params as Record<string, any> | undefined)?.clusterName
        || '';

    // The actions wear the colour identity of the cluster they will open into,
    // handed to CSS as a custom property exactly like FloatableTab's
    // `--tab-accent` — so the stylesheet decides how much of it to use and an
    // arbitrary picker hex never has to carry an icon glyph's contrast.
    // `null` when there is no cluster; the CSS falls back to its neutral look.
    const accent = useClusterColor(clusterName);

    const model = useMemo(() => {
        // Both openers call `api.addPanel` without a position, so the panel
        // lands in whichever group is *active*. Activating this group first is
        // the only thing that makes a split layout open into the clicked bar —
        // the same assumption DockviewContainer's void-container double-click
        // already relies on.
        const inThisGroup = (open: (cluster: string) => void) => () => {
            api.setActive();
            open(clusterName);
        };

        return [
            {
                label: t('nav:menu.terminal'),
                icon: <VscTerminal size={16} />,
                command: inThisGroup(openTerminal),
            },
            {
                label: t('nav:menu.yamlEditor'),
                icon: <VscCloudUpload size={16} />,
                command: inThisGroup(openApplyYaml),
            },
        ];
    }, [t, api, clusterName, openTerminal, openApplyYaml]);

    return (
        <div className="dv-group-actions" style={accent ? { ['--dial-accent' as string]: accent } : undefined}>
            <SpeedDial
                model={model}
                // `right`, not `down`, purely for the inline `flex-direction:
                // row` PrimeReact writes onto the list for the horizontal
                // directions — the stylesheet then drops the row below the
                // button and centres it. Setting the axis from CSS is not an
                // option: PrimeReact's is an inline style.
                direction="right"
                type="linear"
                transitionDelay={40}
                showIcon={<VscAdd size={13} />}
                hideIcon={<VscChromeClose size={13} />}
                aria-label={t('nav:menu.newPanel')}
            />
        </div>
    );
}
