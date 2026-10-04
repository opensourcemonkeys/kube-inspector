import { describe, it, expect, vi, beforeEach } from 'vitest';

const detachTerminal = vi.fn();
const detachExec = vi.fn();
vi.mock('../../wailsjs/go/controller_app/App', () => ({
    DetachTerminalSession: (id: string) => detachTerminal(id),
    DetachPodExecSession: (id: string) => detachExec(id),
}));

import { prepareWindowHandoff, consumeHandoff, createOutputGate, isWindowOnly } from './terminalHandoff';

describe('window hand-off', () => {
    beforeEach(() => {
        detachTerminal.mockReset().mockResolvedValue(undefined);
        detachExec.mockReset().mockResolvedValue(undefined);
    });

    it('detaches a terminal before the panel is sent and flags it for attach', async () => {
        const panel = { componentType: 'terminal', title: 'Terminal 1', params: { sessionId: 'terminal-1-1' } };
        const out = await prepareWindowHandoff(panel);

        expect(detachTerminal).toHaveBeenCalledWith('terminal-1-1');
        expect(out.params).toEqual({ sessionId: 'terminal-1-1', handoff: true });
        // The original is left alone: it is what the source still serializes.
        expect(panel.params).toEqual({ sessionId: 'terminal-1-1' });
    });

    it('detaches pod exec and node shell sessions through the exec registry', async () => {
        await prepareWindowHandoff({ componentType: 'podExec', title: '', params: { sessionId: 'exec-1' } });
        await prepareWindowHandoff({ componentType: 'nodeShell', title: '', params: { sessionId: 'nodeshell-1' } });
        expect(detachExec.mock.calls).toEqual([['exec-1'], ['nodeshell-1']]);
        expect(detachTerminal).not.toHaveBeenCalled();
        expect(consumeHandoff('exec-1')).toBe(true);
        expect(consumeHandoff('nodeshell-1')).toBe(true);
    });

    it('tells the closing panel exactly once that its session moved', async () => {
        await prepareWindowHandoff({ componentType: 'terminal', title: '', params: { sessionId: 's2' } });
        expect(consumeHandoff('s2')).toBe(true);
        // A later close of a panel with the same id is a real close.
        expect(consumeHandoff('s2')).toBe(false);
    });

    // Nothing in the backend is holding it, so the source must close it the
    // normal way — otherwise a session that comes up late has no owner at all.
    it('lets the source close a session the backend could not detach', async () => {
        detachExec.mockRejectedValue(new Error('exec session s3 not found'));
        const out = await prepareWindowHandoff({ componentType: 'podExec', title: '', params: { sessionId: 's3' } });
        expect(out.params.handoff).toBe(true);
        expect(consumeHandoff('s3')).toBe(false);
    });

    it('passes other panels through untouched', async () => {
        const panel = { componentType: 'yamlEditor', title: 'x', params: { name: 'a' } };
        expect(await prepareWindowHandoff(panel)).toBe(panel);
        expect(detachTerminal).not.toHaveBeenCalled();
        expect(detachExec).not.toHaveBeenCalled();
    });

    it('keeps session panels to this process', () => {
        expect(['terminal', 'podExec', 'nodeShell'].every(isWindowOnly)).toBe(true);
        expect(isWindowOnly('yamlEditor')).toBe(false);
    });
});

describe('output gate', () => {
    it('writes straight through when not attaching', () => {
        const out: string[] = [];
        const gate = createOutputGate(d => out.push(d), false);
        gate.onOutput('a', 1);
        gate.onOutput('b', 2);
        expect(out).toEqual(['a', 'b']);
    });

    it('replays the snapshot, then only the chunks past it', () => {
        const out: string[] = [];
        const gate = createOutputGate(d => out.push(d), true);
        // Streamed while the attach was in flight: one already in the snapshot.
        gate.onOutput('old', 5);
        gate.onOutput('new', 8);
        expect(out).toEqual([]);

        gate.replay({ data: 'hello', offset: 5 });
        // Events and the RPC reply travel separately: a chunk the snapshot
        // already covers can still arrive after it, and must be dropped.
        gate.onOutput('late-dup', 5);
        gate.onOutput('next', 12);
        expect(out).toEqual(['hello', 'new', 'next']);
    });

    it('releases held chunks when the attach failed', () => {
        const out: string[] = [];
        const gate = createOutputGate(d => out.push(d), true);
        gate.onOutput('x', 3);
        gate.replay(null);
        expect(out).toEqual(['x']);
    });
});
