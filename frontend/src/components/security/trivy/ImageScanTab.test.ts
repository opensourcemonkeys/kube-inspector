import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const scanImage = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    TrivyScanImage: (...a: unknown[]) => scanImage(...a),
    TrivyExportImageReport: vi.fn(),
}));

import { useImageScanner } from './ImageScanTab';

describe('useImageScanner', () => {
    beforeEach(() => { scanImage.mockReset(); });

    it('keeps an image whose scan call failed in the results, so the report lists it', async () => {
        scanImage.mockImplementation((_c: string, image: string) => image === 'bad:1'
            ? Promise.reject(new Error('registry unreachable'))
            : Promise.resolve({ kind: 'image', artifactRef: image, targets: [], summary: {}, scannedAt: '', error: '' }));
        const pushToast = vi.fn();
        const { result } = renderHook(() => useImageScanner('c', pushToast));

        await act(async () => { await result.current.scanImages(['ok:1', 'bad:1']); });

        expect(result.current.results.map((r) => r.artifactRef)).toEqual(['ok:1', 'bad:1']);
        const failed = result.current.results[1];
        expect(failed.error).toMatch(/registry unreachable/);
        expect(failed.targets).toEqual([]);
        expect(pushToast).toHaveBeenCalledWith('error', expect.any(String), expect.stringMatching(/registry unreachable/));
    });
});
