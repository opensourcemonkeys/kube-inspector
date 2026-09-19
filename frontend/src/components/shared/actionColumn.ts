import type { ColumnProps } from 'primereact/column';

// Props that pin a table's row-action column to the right edge. A resource
// table is often wider than its Dockview panel, and the buttons that act on a
// row are exactly what scrolled off-screen first. The sticky cells need an
// opaque background, which theme-monolith.css supplies via `.p-frozen-column`.
//
// ResourceListView applies this to its merged action column automatically;
// hand-written tables spread it onto their own `header=""` column.
export const ACTION_COLUMN_PROPS: Pick<ColumnProps, 'frozen' | 'alignFrozen' | 'headerClassName' | 'bodyClassName'> = {
    frozen: true,
    alignFrozen: 'right',
    headerClassName: 'ktable-actions-col',
    bodyClassName: 'ktable-actions-cell',
};
