import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusLamp, { toneFor } from './StatusLamp';

describe('StatusLamp', () => {
    it('maps every Tag severity the list helpers return to a tone', () => {
        expect(toneFor('success')).toBe('ok');
        expect(toneFor('warning')).toBe('warn');
        expect(toneFor('danger')).toBe('err');
        expect(toneFor('info')).toBe('info');
        expect(toneFor('secondary')).toBe('idle');
        expect(toneFor(undefined)).toBe('idle');
    });

    // The state must be readable without the lamp's color or shape — the text
    // is what a screen reader announces, and the mark is hidden from it.
    it('renders the label as text and hides the mark from assistive tech', () => {
        const { container } = render(<StatusLamp label="CrashLoopBackOff" severity="danger" />);
        expect(screen.getByText('CrashLoopBackOff')).toBeTruthy();
        expect(container.querySelector('.lamp--err')).toBeTruthy();
        expect(container.querySelector('.lamp__mark')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('lets an explicit tone override the severity', () => {
        const { container } = render(<StatusLamp label="Ready" severity="danger" tone="ok" />);
        expect(container.querySelector('.lamp--ok')).toBeTruthy();
    });
});
