import { useT } from '../../i18n/useT';

/**
 * The one progress indicator for work that is actually running (a graph being
 * built, a scan, a save). A thin accent arc — the only looping motion the app
 * allows, and only while something is in progress. Lists use the static
 * ListSkeleton instead; this is for a spot that has no shape to preview.
 *
 * Replaces MUI's CircularProgress, which was the app's only use of MUI.
 */
export default function Spinner({ size = 16, label }: { size?: number; label?: string }) {
    const t = useT();
    return (
        <span className="spinner" role="status" style={{ width: size, height: size }}>
            <span className="sr-only">{label ?? t('status.loading')}</span>
        </span>
    );
}
