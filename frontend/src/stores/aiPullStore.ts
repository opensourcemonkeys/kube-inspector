import { create } from 'zustand';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { PullAiModel, StopAiPull } from '../../wailsjs/go/controller_app/App';

export interface PullState { percent: number; status: string; error?: string; }

interface AiPullStore {
    /** In-flight (or failed) downloads, by model reference. */
    pulls: Record<string, PullState>;
    /** Bumped when a download finishes, so model lists know to reload. */
    completed: number;
    /** The model the last finished download installed. */
    lastCompleted: string;
    start: (host: string, model: string, startingLabel: string) => void;
    cancel: (model: string) => void;
}

/**
 * Model downloads belong to the Ollama host, not to one assistant tab: a pull
 * started in one tab keeps its progress bar when that tab closes and shows in
 * every other one. The ai:pull* events are therefore subscribed once, here,
 * for the life of the window — a per-tab EventsOff would also have removed
 * every other tab's listeners, since it drops all callbacks for a name.
 * Not persisted: a restart has no download to resume.
 */
export const useAiPullStore = create<AiPullStore>()((set) => ({
    pulls: {},
    completed: 0,
    lastCompleted: '',
    start: (host, model, startingLabel) => {
        listen();
        set((s) => ({ pulls: { ...s.pulls, [model]: { percent: 0, status: startingLabel } } }));
        PullAiModel(host, model).catch((e) =>
            set((s) => ({ pulls: { ...s.pulls, [model]: { percent: 0, status: 'error', error: String(e) } } })));
    },
    cancel: (model) => {
        StopAiPull(model).catch(() => {});
        set((s) => {
            const pulls = { ...s.pulls };
            delete pulls[model];
            return { pulls };
        });
    },
}));

let listening = false;
function listen() {
    if (listening) return;
    listening = true;
    const set = useAiPullStore.setState;
    EventsOn('ai:pull', (p: { model: string; percent?: number; status?: string }) =>
        set((s) => ({ pulls: { ...s.pulls, [p.model]: { percent: p.percent || 0, status: p.status || '' } } })));
    EventsOn('ai:pull-done', (p: { model: string }) =>
        set((s) => {
            const pulls = { ...s.pulls };
            delete pulls[p.model];
            return { pulls, completed: s.completed + 1, lastCompleted: p.model };
        }));
    EventsOn('ai:pull-error', (p: { model: string; error: string }) =>
        set((s) => ({ pulls: { ...s.pulls, [p.model]: { percent: s.pulls[p.model]?.percent || 0, status: 'error', error: p.error } } })));
}
