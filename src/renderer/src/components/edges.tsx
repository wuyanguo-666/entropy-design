import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'

export interface LineageEdgeData {
  onDelete?: (id: string) => void
  [key: string]: unknown
}

export type LineageEdgeType = Edge<LineageEdgeData>

/** Bezier edge with a delete button that appears when selected. */
export function LineageEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data
}: EdgeProps<LineageEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={20} />
      {selected && data?.onDelete && (
        <EdgeLabelRenderer>
          <button
            className="edge-del nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              data.onDelete?.(id)
            }}
            title="删除连线"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
