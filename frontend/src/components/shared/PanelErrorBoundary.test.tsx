import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PanelErrorBoundary from './PanelErrorBoundary';
import ErrorBanner from './ErrorBanner';
import { useDiagnosticsStore } from '../../stores/diagnosticsStore';

// Throws while `armed` is set. The flag is read inside the render rather than
// taken as a prop on purpose: "Reload panel" remounts the boundary's children
// without re-rendering their parent, so a prop captured in the existing element
// would still say "throw" and the remount could not be observed.
let armed = true;
function Bomb() {
    if (armed) throw new Error('kaboom');
    return <div>panel content</div>;
}

beforeEach(() => {
    // React logs the caught error itself; keep the test output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useDiagnosticsStore.setState({ uiErrors: [] });
    armed = true;
});

afterEach(() => vi.restoreAllMocks());

describe('PanelErrorBoundary', () => {
    it('renders a crash card instead of unmounting the tree, and records the stack', () => {
        render(
            <PanelErrorBoundary label="pods:test">
                <Bomb />
            </PanelErrorBoundary>,
        );

        expect(screen.getByText('This panel hit an error')).toBeTruthy();
        expect(screen.getByText('kaboom')).toBeTruthy();

        // The stack is the only record of a renderer crash — nothing in the Go
        // log file can see it — so "Copy diagnostics" has to find it here.
        const recorded = useDiagnosticsStore.getState().uiErrors;
        expect(recorded).toHaveLength(1);
        expect(recorded[0].where).toBe('pods:test');
        expect(recorded[0].message).toBe('kaboom');
        expect(recorded[0].stack).toBeTruthy();
    });

    it('remounts the subtree when the panel is reloaded', () => {
        render(
            <PanelErrorBoundary label="pods:test">
                <Bomb />
            </PanelErrorBoundary>,
        );
        expect(screen.getByText('This panel hit an error')).toBeTruthy();

        armed = false;
        fireEvent.click(screen.getByText('Reload panel'));

        expect(screen.getByText('panel content')).toBeTruthy();
    });

    it('does not persist crashes across runs', () => {
        // uiErrors is excluded from the store's persisted slice: a crash from a
        // previous session must not turn up in this session's report.
        useDiagnosticsStore.getState().recordUiError('pods:test', 'kaboom', 'stack');
        const persisted = JSON.parse(localStorage.getItem('kube-ins-diagnostics') ?? '{}');
        expect(persisted.state?.uiErrors).toBeUndefined();
    });
});

describe('ErrorBanner', () => {
    it('renders nothing without a message', () => {
        const { container } = render(<ErrorBanner message={null} />);
        expect(container.firstChild).toBeNull();
    });

    it('shows the backend message verbatim and retries on demand', () => {
        const onRetry = vi.fn();
        const msg = 'list pods in cluster "prod": pods is forbidden: User "dev" cannot list resource "pods"';
        render(<ErrorBanner message={msg} onRetry={onRetry} stale />);

        expect(screen.getByText(msg)).toBeTruthy();
        expect(screen.getByText('Showing last known data')).toBeTruthy();

        fireEvent.click(screen.getByText('Retry'));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it('stays dismissed for the same failure and reappears for a different one', () => {
        const { rerender } = render(<ErrorBanner message="first failure" />);
        fireEvent.click(screen.getByLabelText('Dismiss'));
        expect(screen.queryByText('first failure')).toBeNull();

        // A repeat of the same failure stays hidden — that is what dismissing asked for.
        rerender(<ErrorBanner message="first failure" />);
        expect(screen.queryByText('first failure')).toBeNull();

        rerender(<ErrorBanner message="second failure" />);
        expect(screen.getByText('second failure')).toBeTruthy();
    });
});
