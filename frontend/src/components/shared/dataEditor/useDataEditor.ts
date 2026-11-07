import { useCallback, useEffect, useMemo, useState } from 'react';
import { GetDataObject } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { errText } from '../../../lib/errText';
import { markDirty } from '../../../lib/unsavedChanges';
import {
    bytesToBase64, bytesToText, diffEntries, entriesFromObject, nextEntryId, rebaseDraft,
    type DataKind, type Entry,
} from './dataEditorModel';

export interface ObjectMeta { resourceVersion: string; type: string; immutable: boolean }

/** The key the list shows first (it sorts by locale, the API server by bytes). */
const firstInListOrder = (entries: Entry[]) =>
    entries.filter((e) => !e.deleted).sort((a, b) => a.key.localeCompare(b.key))[0];

/** A fresh copy with new ids, so the editor builds new Monaco models for it. */
const fresh = (entries: Entry[]) => entries.map((e) => ({ ...e, id: nextEntryId() }));

/**
 * The editor's state: the object as loaded (`original`), the user's `draft`
 * over it, and the selected key. The panel id is marked dirty in
 * lib/unsavedChanges while the draft differs, so its tab asks before closing.
 */
export function useDataEditor(clusterName: string, kind: DataKind, namespace: string, name: string, panelId: string) {
    const [meta, setMeta] = useState<ObjectMeta | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [original, setOriginal] = useState<Entry[]>([]);
    const [draft, setDraft] = useState<Entry[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    // Bumped when a value changes outside Monaco (a form, a file), so the
    // editor drops its model for that key instead of showing stale text.
    const [revs, setRevs] = useState<Record<number, number>>({});

    const fetchObject = useCallback(
        () => GetDataObject(clusterName, kind, namespace, name),
        [clusterName, kind, namespace, name],
    );

    /** Takes obj as the new original; keepKey keeps that key selected if it is still there. */
    const adopt = useCallback((obj: models.DataObject, nextDraft?: Entry[], keepKey?: string) => {
        const loaded = entriesFromObject(obj.entries ?? []);
        const d = nextDraft ?? fresh(loaded);
        setMeta({ resourceVersion: obj.resourceVersion, type: obj.type, immutable: obj.immutable });
        setOriginal(loaded);
        setDraft(d);
        const kept = keepKey === undefined ? undefined : d.find((e) => e.key === keepKey && !e.deleted);
        setSelectedId(kept?.id ?? firstInListOrder(d)?.id ?? null);
        setLoadError(null);
    }, []);

    const load = useCallback(async () => {
        try {
            adopt(await fetchObject());
        } catch (e) {
            setLoadError(errText(e));
        }
    }, [adopt, fetchObject]);

    useEffect(() => { void load(); }, [load]);

    const changes = useMemo(() => diffEntries(original, draft), [original, draft]);
    const dirty = changes.length > 0;

    useEffect(() => {
        markDirty(panelId, dirty);
    }, [panelId, dirty]);
    useEffect(() => () => markDirty(panelId, false), [panelId]);

    const update = (id: number, patch: Partial<Entry>) =>
        setDraft((d) => d.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    const bump = (id: number) => setRevs((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }));

    /** fromEditor: the change came from Monaco itself, whose model already has it. */
    const setValue = (id: number, value: string, fromEditor = false) => {
        update(id, { value });
        if (!fromEditor) bump(id);
    };

    const setKey = (id: number, key: string) => update(id, { key });

    const add = (key = '', value = '', binary = false) => {
        const e: Entry = { id: nextEntryId(), key, value, binary };
        setDraft((d) => [...d, e]);
        setSelectedId(e.id);
        return e.id;
    };

    /** A file's bytes as text when they are UTF-8, otherwise kept as base64. */
    const fileValue = (bytes: Uint8Array) => {
        const text = bytesToText(bytes);
        return text === null ? { value: bytesToBase64(bytes), binary: true } : { value: text, binary: false };
    };

    const addFile = (fileName: string, bytes: Uint8Array) => {
        const { value, binary } = fileValue(bytes);
        const key = fileName.replace(/[^-._a-zA-Z0-9]/g, '_');
        const existing = draft.find((e) => e.key === key && !e.deleted);
        if (existing) {
            replaceWithFile(existing.id, bytes);
            setSelectedId(existing.id);
            return;
        }
        add(key, value, binary);
    };

    const replaceWithFile = (id: number, bytes: Uint8Array) => {
        update(id, fileValue(bytes));
        bump(id);
    };

    /** A key added in this session goes at once; a loaded one is marked so it can be restored. */
    const remove = (id: number) => {
        const e = draft.find((x) => x.id === id);
        if (!e) return;
        if (e.origKey === undefined) {
            const rest = draft.filter((x) => x.id !== id);
            setDraft(rest);
            if (selectedId === id) setSelectedId(rest.find((x) => !x.deleted)?.id ?? null);
        } else {
            update(id, { deleted: true });
        }
    };

    const restore = (id: number) => update(id, { deleted: false });

    const revert = () => {
        const d = fresh(original);
        const origKey = draft.find((e) => e.id === selectedId)?.origKey;
        setDraft(d);
        setSelectedId(d.find((e) => e.key === origKey)?.id ?? firstInListOrder(d)?.id ?? null);
    };

    const selectedKey = () => draft.find((e) => e.id === selectedId)?.key;

    /** After a conflict: the user's changes replayed onto the object as it is now. */
    const rebase = async () => {
        const latest = await fetchObject();
        adopt(latest, rebaseDraft(original, draft, entriesFromObject(latest.entries ?? [])), selectedKey());
    };

    /** After a save: the saved object becomes the new original. */
    const reloadKeepingSelection = async () => {
        adopt(await fetchObject(), undefined, selectedKey());
    };

    return {
        meta, loadError, original, draft, changes, dirty, revs,
        selectedId, setSelectedId,
        load, setValue, setKey, add, addFile, replaceWithFile, remove, restore, revert, rebase, reloadKeepingSelection,
    };
}

export type DataEditorState = ReturnType<typeof useDataEditor>;
