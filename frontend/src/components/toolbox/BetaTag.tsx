import { Tag } from 'primereact/tag';
import { useT } from '../../i18n/useT';

/**
 * Marks the panels that depend on toolbox, the in-cluster recorder, which is
 * still a beta (its own version line, toolbox-v1.0.0-beta.*) while Kube
 * Inspector itself is stable. A Tag, not a StatusLamp: it labels what the
 * feature is, not a state it is in. The hover text carries the compatibility
 * note in full.
 */
export default function BetaTag() {
    const t = useT();
    return <Tag value={t('panels:toolbox.beta')} title={t('panels:toolbox.betaNote')} className="beta-tag" />;
}
