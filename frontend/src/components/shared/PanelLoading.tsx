import Spinner from './Spinner';

/**
 * Centred spinner for a panel region whose content has not arrived yet.
 *
 * Used by the YAML panels in place of the placeholder text they used to seed
 * the Monaco model with: a model created holding "Loading..." puts the
 * placeholder→document transition on Monaco's undo stack, so the first Ctrl+Z
 * on an untouched editor wiped the object. Keep the editor unmounted until its
 * real content exists and that entry never exists either.
 */
export default function PanelLoading() {
    return (
        <div className="panel-loading dark-display">
            <Spinner size={22} />
        </div>
    );
}
