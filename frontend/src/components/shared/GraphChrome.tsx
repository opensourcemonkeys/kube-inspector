import { Background, BackgroundVariant, Controls, MiniMap, type Node } from 'reactflow';
import { themeAlpha, themeColor, type ThemeVar } from '../../lib/themeColors';

/**
 * The dot grid, zoom keys and minimap every graph panel shows (cluster
 * resources, security role map, network policy), in one place.
 *
 * The minimap's mask and node colours are SVG attributes, where `var(--x)`
 * never resolves, so they are resolved here — and the mask defaulted to
 * reactflow's light grey, which drew a pale box over a dark app. The keys are
 * styled from theme-monolith.css (`.react-flow__controls`).
 *
 * Render inside <ReactFlow>. The panel subscribes to the theme, so a palette
 * switch re-renders this and repaints the attributes.
 */
export default function GraphChrome({ nodeColor }: {
    /** The palette variable for a node — resolved to a colour for the minimap. */
    nodeColor: (node: Node) => ThemeVar;
}) {
    return (
        <>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={themeColor('--line-strong')} />
            <Controls showInteractive={false} />
            <MiniMap
                pannable
                zoomable
                maskColor={themeAlpha('--well', 0.72)}
                nodeColor={(n) => themeColor(nodeColor(n))}
                nodeStrokeWidth={0}
            />
        </>
    );
}
