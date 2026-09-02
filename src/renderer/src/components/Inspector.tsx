import { useMemo } from 'react'
import type { CanvasDocument, CanvasNode } from '@shared/types'
import { fileUrl, projectFileUrl } from '../api'
import Icon from './Icon'

interface Props {
  doc: CanvasDocument
  selection: string[]
  onClose: () => void
}

function mediaSrc(node: CanvasNode): string | null {
  const p = node.data.path
  if (!p) return null
  return p.startsWith('/') ? fileUrl(p) : projectFileUrl((node.data.projectPath as string) || '', p)
}

/** Walk the sourceNodeId / explicit-edge ancestry of a node, nearest first. */
function ancestorsOf(node: CanvasNode, doc: CanvasDocument): CanvasNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const out: CanvasNode[] = []
  const seen = new Set<string>([node.id])
  let cur: string | undefined = (node.data.sourceNodeId as string | undefined) ?? undefined
  if (!cur) {
    const incoming = doc.edges.filter((e) => e.target === node.id).map((e) => e.source)
    cur = incoming[0]
  }
  while (cur && !seen.has(cur)) {
    const n = byId.get(cur)
    if (!n) break
    out.push(n)
    seen.add(cur)
    cur = (n.data.sourceNodeId as string | undefined) ?? doc.edges.find((e) => e.target === cur)?.source
  }
  return out
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="insp-row">
      <span className="insp-label">{label}</span>
      <span className="insp-value">{value}</span>
    </div>
  )
}

/**
 * Node inspector: the transparency that BYO-API tooling exists for — show which
 * provider/model/prompt produced this node and where its source lineage is.
 * Rendered as a floating card over the canvas (App owns open state; `I` toggles).
 */
export default function Inspector({ doc, selection, onClose }: Props) {
  const nodes = useMemo(
    () => selection.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n && n.type !== 'group'),
    [doc, selection]
  )
  const node = nodes.length === 1 ? nodes[0] : null

  return (
    <div className="inspector">
      <div className="insp-head">
        <Icon name="scan" size={14} />
        <span className="insp-title">节点检视</span>
        <button className="insp-close" title="关闭 (I)" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="insp-body">
        {nodes.length === 0 && <div className="hint">在画布上选中一个节点查看其来源与参数</div>}
        {nodes.length > 1 && <div className="hint">已选 {nodes.length} 个节点 · 单选以查看详情</div>}
        {node && (
          <>
            <div className="insp-name">{node.data.name}</div>
            <div className="insp-type">{node.type}</div>
            {node.type === 'image' && mediaSrc(node) && <img className="insp-media" src={mediaSrc(node)!} alt="" />}
            {node.type === 'video' && mediaSrc(node) && <video className="insp-media" src={mediaSrc(node)!} controls muted />}
            {node.type === 'audio' && mediaSrc(node) && <audio className="insp-media" src={mediaSrc(node)!} controls />}
            <Row label="provider" value={node.data.provider || null} />
            <Row label="model" value={node.data.model || null} />
            <Row label="path" value={node.data.path || null} />
            {node.data.prompt && (
              <div className="insp-prompt">{String(node.data.prompt)}</div>
            )}
            {node.type === 'text' && node.data.text && <div className="insp-prompt">{node.data.text}</div>}
            {ancestorsOf(node, doc).length > 0 && (
              <div className="insp-lineage">
                <span className="insp-label">生成自</span>
                <div className="insp-chain">
                  {ancestorsOf(node, doc).map((a) => (
                    <span key={a.id} className="insp-chip">
                      {a.data.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
