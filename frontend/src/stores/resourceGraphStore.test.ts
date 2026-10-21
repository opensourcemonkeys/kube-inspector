import { beforeEach, describe, expect, it } from 'vitest';
import { defaultGraphView, useResourceGraphStore } from './resourceGraphStore';

const KEY = 'resourceGraph:c1';

beforeEach(() => useResourceGraphStore.setState({ views: {}, savedViews: {} }));

describe('saved resource graph views', () => {
    it('saves by name, replaces a view of the same name, keeps them sorted', () => {
        const { saveView } = useResourceGraphStore.getState();
        const base = { ...defaultGraphView() };
        delete (base as Partial<typeof base>).refreshSec;
        saveView(KEY, { name: 'prod', settings: { ...base, namespaces: ['prod'] } });
        saveView(KEY, { name: 'all', settings: { ...base, namespaces: [] } });
        saveView(KEY, { name: 'prod', settings: { ...base, namespaces: ['prod', 'db'] } });
        const list = useResourceGraphStore.getState().savedViews[KEY];
        expect(list.map(v => v.name)).toEqual(['all', 'prod']);
        expect(list[1].settings.namespaces).toEqual(['prod', 'db']);
    });

    it('deletes one view and leaves other clusters alone', () => {
        const { saveView, deleteView } = useResourceGraphStore.getState();
        const settings = { ...defaultGraphView() };
        saveView(KEY, { name: 'x', settings });
        saveView('resourceGraph:c2', { name: 'x', settings });
        deleteView(KEY, 'x');
        const s = useResourceGraphStore.getState().savedViews;
        expect(s[KEY]).toEqual([]);
        expect(s['resourceGraph:c2']).toHaveLength(1);
    });

    it('fills settings added later with their defaults', () => {
        useResourceGraphStore.getState().patchView(KEY, { direction: 'LR' });
        const v = useResourceGraphStore.getState().views[KEY];
        expect(v).toMatchObject({ direction: 'LR', groupBy: 'none', collapsed: {} });
    });
});
