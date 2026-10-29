import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import InstallGuide from './InstallGuide';

describe('InstallGuide', () => {
    it('fills in the cluster name, quoted for the shell', () => {
        const { container } = render(<InstallGuide clusterName="it's prod 3" />);
        const cmd = container.querySelector('pre')?.textContent ?? '';
        expect(cmd).toContain('helm install toolbox oci://ghcr.io/opensourcemonkeys/charts/toolbox');
        expect(cmd).toContain(`--set-string clusterName='it'\\''s prod 3'`);
    });
});
