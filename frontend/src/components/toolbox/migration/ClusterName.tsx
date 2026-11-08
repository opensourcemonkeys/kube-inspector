import { useClusterColor } from '../../../stores/clusterColorStore';

/** A cluster's name with its colour, so two clusters cannot be mistaken for each other. */
export default function ClusterName({ name }: { name: string }) {
    const color = useClusterColor(name);
    return (
        <span className="mig-cluster" style={color ? { ['--dot' as string]: color } : undefined}>
            <span className="mig-cluster__dot" aria-hidden />
            {name}
        </span>
    );
}
