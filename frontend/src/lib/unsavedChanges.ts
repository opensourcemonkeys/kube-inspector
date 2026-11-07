/**
 * Panels holding edits that have not been saved, by Dockview panel id.
 *
 * An editor marks itself while it is dirty and clears the mark when it saves
 * or unmounts; the tab header (`FloatableTab`) asks before closing or moving
 * a marked panel, since neither carries the draft along.
 */
const dirtyPanels = new Set<string>();

export function markDirty(panelId: string, dirty: boolean): void {
    if (dirty) dirtyPanels.add(panelId);
    else dirtyPanels.delete(panelId);
}

export function isDirty(panelId: string): boolean {
    return dirtyPanels.has(panelId);
}
