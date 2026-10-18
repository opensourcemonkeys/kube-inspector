/**
 * Row height of every virtual-scrolled table, in px.
 *
 * PrimeReact's VirtualScroller positions rows from `itemSize`, while the rows'
 * real height comes from theme-monolith.css (`td { height: var(--row-h) }`).
 * The two must agree or a scrolled list renders rows at the wrong offsets —
 * which the Events list (46) and the CRD instance table (40) each did on their
 * own once the CSS height moved. One constant, beside the CSS token it mirrors.
 */
export const ROW_HEIGHT = 32;
