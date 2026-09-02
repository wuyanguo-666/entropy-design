import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon'
import {
  ReactFlow,
  Background,
  Panel,
  MiniMap,
  ConnectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import type { CanvasDocument, CanvasEdge } from '@shared/types'
import { base, apiToken } from '../api'
import { nodeTypes, type OCNode } from './nodes'
import { LineageEdgeView, type LineageEdgeType } from './edges'

const TYPE_MAP: Record<string, string> = {
  image: 'ocImage',
  text: 'ocText',
  table: 'ocTable',
  file: 'ocFile',
  video: 'ocVideo',
  audio: 'ocAudio',
  group: 'ocGroup'
}

const edgeTypes = { lineage: LineageEdgeView }

interface Props {
  doc: CanvasDocument
  projectPath: string
  onDocChange: (doc: CanvasDocument) => void
  onSelectionChange?: (nodeIds: string[]) => void
  onToast?: (msg: string) => void
}

/** Track html.dark (set by the theme setting) so canvas chrome follows the theme. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

export default function CanvasBoard({ doc, projectPath, onDocChange, onSelectionChange, onToast }: Props) {
  const dark = useIsDark()

  // JSON stores ABSOLUTE positions; React Flow children are parent-RELATIVE → convert both ways.
  const absById = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of doc.nodes || []) m.set(n.id, n.positions?.main ?? { x: 0, y: 0 })
    return m
  }, [doc])

  const orderedNodes = useMemo(() => {
    const arr = [...(doc.nodes || [])]
    // React Flow requires a parent node to appear before its children in the array
    arr.sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1))
    return arr
  }, [doc])

  // card-level delete (hover ×) — groups take their children with them
  const deleteNodeById = useCallback(
    (id: string) => {
      const removed = new Set([id])
      onDocChange({
        ...doc,
        nodes: (doc.nodes || []).filter((n) => !removed.has(n.id) && !removed.has(n.parentId || '')),
        edges: (doc.edges || []).filter((e) => !removed.has(e.source) && !removed.has(e.target))
      })
    },
    [doc, onDocChange]
  )

  const renameNode = useCallback(
    (id: string, name: string) => {
      onDocChange({
        ...doc,
        nodes: (doc.nodes || []).map((n) => (n.id === id ? { ...n, data: { ...n.data, name } } : n))
      })
    },
    [doc, onDocChange]
  )

  // right-click context menu (rename / delete), positioned inside the canvas wrap
  const wrapRef = useRef<HTMLDivElement>(null)
  const rfInstance = useRef<{ fitView: (o?: { padding?: number; duration?: number }) => void; zoomIn: (o?: { duration?: number }) => void; zoomOut: (o?: { duration?: number }) => void; getViewport: () => { zoom: number } } | null>(null)
  const [zoomPct, setZoomPct] = useState(100)
  const [showMiniMap, setShowMiniMap] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [renameRequest, setRenameRequest] = useState<string | null>(null)

  const openCtxMenu = useCallback((id: string, clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    const x = rect ? clientX - rect.left : clientX
    const y = rect ? clientY - rect.top : clientY
    setCtxMenu({ x: Math.max(4, x), y: Math.max(4, y), nodeId: id })
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [ctxMenu])

  const startRename = useCallback((id: string) => {
    setCtxMenu(null)
    setRenameRequest(id)
  }, [])

  // Local interactive copy: drag/selection changes apply here instantly (smooth dragging);
  // positions are persisted to `doc` only on drag stop.
  const [rfNodes, setRfNodes] = useState<OCNode[]>([])
  useEffect(() => {
    setRfNodes(
      orderedNodes.map((n) => {
        const abs = n.positions?.main ?? { x: 0, y: 0 }
        const parentAbs = n.parentId ? absById.get(n.parentId) : null
        const position = parentAbs ? { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y } : abs
        const isGroup = n.type === 'group'
        return {
          id: n.id,
          type: TYPE_MAP[n.type] || 'ocFile',
          position,
          parentId: n.parentId,
          style: isGroup
            ? { width: n.size?.width ?? 480, height: n.size?.height ?? 320, zIndex: 0 }
            : undefined,
          data: {
            ...n.data,
            projectPath,
            onDeleteNode: deleteNodeById,
            onRenameNode: renameNode,
            onNodeContextMenu: openCtxMenu,
            renameRequest,
            clearRenameRequest: () => setRenameRequest(null)
          } as OCNode['data']
        }
      })
    )
  }, [orderedNodes, projectPath, absById, deleteNodeById, renameNode, openCtxMenu, renameRequest])

  // Delete one connection: stored edges are removed from doc.edges; implied lineage
  // edges (derived from data.sourceNodeId) are cancelled by clearing that field.
  const deleteEdge = useCallback(
    (id: string) => {
      if ((doc.edges || []).some((e) => e.id === id)) {
        onDocChange({ ...doc, edges: (doc.edges || []).filter((e) => e.id !== id) })
        return
      }
      const child = (doc.nodes || []).find((n) => {
        const src = n.data?.sourceNodeId
        return typeof src === 'string' && `e-${src}-${n.id}` === id
      })
      if (child) {
        onDocChange({
          ...doc,
          nodes: (doc.nodes || []).map((n) =>
            n.id === child.id ? { ...n, data: { ...n.data, sourceNodeId: undefined } } : n
          )
        })
      }
    },
    [doc, onDocChange]
  )

  // Edges = explicitly stored connections + IMPLIED lineage edges derived from
  // data.sourceNodeId (like the original: "generated from this asset" draws its own line).
  const derivedEdges = useMemo<Edge[]>(() => {
    const byId = new Map<string, CanvasEdge>()
    for (const e of doc.edges || []) byId.set(e.id, e)
    for (const n of doc.nodes || []) {
      const src = n.data?.sourceNodeId
      if (typeof src !== 'string' || !src) continue
      if (!(doc.nodes || []).some((x) => x.id === src)) continue
      const id = `e-${src}-${n.id}`
      if (!byId.has(id) && ![...byId.values()].some((e) => e.source === src && e.target === n.id)) {
        byId.set(id, { id, source: src, target: n.id })
      }
    }
    return [...byId.values()].map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'lineage',
      animated: false,
      data: { onDelete: deleteEdge }
    }))
  }, [doc, deleteEdge])

  // Local interactive copy for edges TOO — without this, RF's "select an edge" change is
  // dropped (controlled prop never updates) and the selected state / delete button never show.
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  useEffect(() => {
    setRfEdges(derivedEdges)
  }, [derivedEdges])

  const commit = useCallback(
    (current: OCNode[]) => {
      // pass 1: fresh absolute positions for top-level nodes (a dragged group moves its children)
      const newAbs = new Map<string, { x: number; y: number }>()
      for (const rf of current) {
        const orig = (doc.nodes || []).find((n) => n.id === rf.id)
        if (orig && !orig.parentId) newAbs.set(rf.id, rf.position)
      }
      // pass 2: children = React Flow relative position + parent's NEW absolute position
      const next: CanvasDocument = {
        ...doc,
        nodes: (doc.nodes || []).map((n) => {
          const rf = current.find((x) => x.id === n.id)
          if (!rf) return n
          if (n.parentId) {
            const parentAbs = newAbs.get(n.parentId) ?? absById.get(n.parentId) ?? { x: 0, y: 0 }
            return {
              ...n,
              positions: {
                main: { x: rf.position.x + parentAbs.x, y: rf.position.y + parentAbs.y }
              }
            }
          }
          return { ...n, positions: { main: rf.position } }
        })
      }
      onDocChange(next)
    },
    [doc, onDocChange, absById]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<OCNode>[]) => {
      const structural = changes.some((c) => c.type === 'remove')
      if (structural) {
        const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
        onDocChange({
          ...doc,
          // deleting a group node also frees (removes) its children
          nodes: (doc.nodes || []).filter((n) => !removed.has(n.id) && !removed.has(n.parentId || '')),
          edges: (doc.edges || []).filter((e) => !removed.has(e.source) && !removed.has(e.target))
        })
        return
      }
      // live position/selection/dimension changes: apply locally for instant feedback
      setRfNodes((ns) => applyNodeChanges(changes, ns))
    },
    [doc, onDocChange]
  )

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: OCNode, current: OCNode[]) => {
      commit(current)
    },
    [commit]
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return
      const edge: CanvasEdge = {
        id: `e-${conn.source}-${conn.target}`,
        source: conn.source,
        target: conn.target
      }
      if ((doc.edges || []).some((e) => e.id === edge.id)) {
        // silent dedupe reads as "connection broken" — always tell the user why
        onToast?.('这两个点之间已经有一条连线了')
        return
      }
      onDocChange({ ...doc, edges: [...(doc.edges || []), edge] })
    },
    [doc, onDocChange, onToast]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      // apply select/hover changes locally so edges actually VISUALLY select
      setRfEdges((es) => applyEdgeChanges(changes, es))
      for (const c of changes) {
        if (c.type === 'remove') deleteEdge(c.id)
      }
    },
    [deleteEdge]
  )

  const onNodesDelete = useCallback(
    (nodesToDelete: OCNode[]) => {
      const removed = new Set(nodesToDelete.map((n) => n.id))
      onDocChange({
        ...doc,
        nodes: (doc.nodes || []).filter((n) => !removed.has(n.id) && !removed.has(n.parentId || '')),
        edges: (doc.edges || []).filter((e) => !removed.has(e.source) && !removed.has(e.target))
      })
    },
    [doc, onDocChange]
  )

  const handleSelectionChange = useCallback(
    (params: { nodes: OCNode[] }) => {
      const ids = params.nodes.filter((n) => n.type !== 'ocGroup').map((n) => n.id)
      setSelectedIds(ids)
      onSelectionChange?.(ids)
    },
    [onSelectionChange]
  )

  // P3 lineage mode (OFF by default — the canvas look is untouched unless enabled):
  // keep only the selection + its upstream/downstream fully visible, dim the rest.
  const [lineageOn, setLineageOn] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const lineageKeep = useMemo(() => {
    if (!lineageOn || selectedIds.length === 0) return null
    const keep = new Set<string>(selectedIds)
    const up = (id: string) => {
      for (const e of rfEdges) if (e.target === id && !keep.has(e.source)) (keep.add(e.source), up(e.source))
    }
    const down = (id: string) => {
      for (const e of rfEdges) if (e.source === id && !keep.has(e.target)) (keep.add(e.target), down(e.target))
    }
    for (const id of [...keep]) {
      up(id)
      down(id)
    }
    return keep
  }, [lineageOn, selectedIds, rfEdges])
  const shownNodes = useMemo(
    () =>
      lineageKeep
        ? rfNodes.map((n) => (n.type === 'ocGroup' || lineageKeep.has(n.id) ? n : { ...n, className: `${n.className ?? ''} lnk-dim` }))
        : rfNodes,
    [rfNodes, lineageKeep]
  )
  const shownEdges = useMemo(
    () =>
      lineageKeep
        ? rfEdges.map((e) =>
            lineageKeep.has(e.source) && lineageKeep.has(e.target) ? e : { ...e, className: `${e.className ?? ''} lnk-dim` }
          )
        : rfEdges,
    [rfEdges, lineageKeep]
  )

  // drag media files from the OS onto the canvas → import as cards
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const onDropImport = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragOver(false)
      const files = Array.from(e.dataTransfer?.files || [])
      if (!files.length || !projectPath) return
      for (const f of files) {
        const buf = await f.arrayBuffer()
        await fetch(
          `${base}/api/canvas/import?path=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(f.name)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-ed-token': apiToken },
            body: buf
          }
        ).catch(() => {})
      }
    },
    [projectPath]
  )

  return (
    <div
      className="canvas-wrap"
      ref={wrapRef}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current++
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={onDropImport}
    >
      <ReactFlow
        onInit={(inst) => {
          rfInstance.current = inst
          setZoomPct(Math.round(inst.getViewport().zoom * 100))
        }}
        onMove={(_e, vp) => setZoomPct(Math.round(vp.zoom * 100))}
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={30}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onConnect={onConnect}
        onSelectionChange={handleSelectionChange}
        deleteKeyCode={['Delete']}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={dark ? '#2c2c2c' : '#dcdfe8'} gap={20} size={1.4} />
        <Panel position="top-right" className="canvas-toolbar">
          <button title="适应画布" onClick={() => rfInstance.current?.fitView({ padding: 0.2, duration: 200 })}>
            <Icon name="scan" size={14} />
          </button>
          <button title="缩小" onClick={() => rfInstance.current?.zoomOut({ duration: 150 })}>
            <Icon name="minus" size={14} />
          </button>
          <span className="ct-zoom">{zoomPct}%</span>
          <button title="放大" onClick={() => rfInstance.current?.zoomIn({ duration: 150 })}>
            <Icon name="plus" size={14} />
          </button>
          <span className="ct-sep" />
          <button
            title="小地图"
            className={showMiniMap ? 'active' : ''}
            onClick={() => setShowMiniMap((v) => !v)}
          >
            <Icon name="grid" size={13} />
          </button>
          <button
            title="溯源高亮：只看选中节点的上游/下游"
            className={lineageOn ? 'active' : ''}
            onClick={() => setLineageOn((v) => !v)}
          >
            <Icon name="arrowUpDown" size={13} />
          </button>
        </Panel>
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            maskColor={dark ? 'rgba(26, 26, 26, 0.6)' : 'rgba(255, 255, 255, 0.6)'}
            nodeColor={dark ? '#3a3a3a' : '#c9cede'}
            style={{ background: dark ? '#1f1f1f' : '#ffffff', border: '1px solid var(--border)' }}
          />
        )}
      </ReactFlow>
      {ctxMenu && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="canvas-ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div
              className="menu-item"
              onClick={() => startRename(ctxMenu.nodeId)}
            >
              <Icon name="pencil" size={13} /> 重命名
            </div>
            <div
              className="menu-item danger"
              onClick={() => {
                deleteNodeById(ctxMenu.nodeId)
                setCtxMenu(null)
              }}
            >
              <Icon name="trash" size={13} /> 删除
            </div>
          </div>
        </>
      )}
      {(doc.nodes?.length ?? 0) === 0 && (
        <div className="canvas-empty">
          <div className="empty-ico">
            <Icon name="sparkles" size={22} />
          </div>
          <div>画布是空的 —— 在右侧和 agent 对话，生成的素材会出现在这里</div>
          <div style={{ fontSize: 11 }}>卡片顶部圆点可连线（一点连多条）；右键卡片可重命名 / 删除</div>
        </div>
      )}
      {dragOver && (
        <div className="drop-hint">
          <div style={{ fontSize: 34 }}>📥</div>
          <div>松手导入文件（图片 / 视频 / 音频）</div>
        </div>
      )}
    </div>
  )
}
