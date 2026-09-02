import { Fragment, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { fileUrl, projectFileUrl } from '../api'
import type { CanvasNodeData } from '@shared/types'

export type OCNode = Node<
  CanvasNodeData & {
    projectPath?: string
    nodeType?: string
    onDeleteNode?: (id: string) => void
    onRenameNode?: (id: string, name: string) => void
    onNodeContextMenu?: (id: string, clientX: number, clientY: number) => void
    renameRequest?: string | null
    clearRenameRequest?: () => void
  },
  string
>

/** ONE handle per card (top center). Loose mode: drag out / drop on the same dot. */
function WithHandles({ children }: { children: React.ReactNode }) {
  return (
    <Fragment>
      <Handle type="source" position={Position.Top} />
      {children}
    </Fragment>
  )
}

/** Card title; rename enters inline edit when the context menu requests it. */
function Head({
  id,
  name,
  type,
  renaming,
  onEditHandled,
  onRename
}: {
  id: string
  name?: string
  type?: string
  renaming?: boolean
  onEditHandled?: () => void
  onRename?: (id: string, name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name || '')

  useEffect(() => {
    if (renaming) {
      setDraft(name || '')
      setEditing(true)
      onEditHandled?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  if (editing) {
    return (
      <div className="head">
        <span className="type">{type || 'node'}</span>
        <input
          className="head-rename nodrag nopan"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false)
            const clean = draft.trim()
            if (clean && clean !== name) onRename?.(id, clean)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
    )
  }
  return (
    <div className="head">
      <span className="type">{type || 'node'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </div>
  )
}

function useCardContextMenu(id: string, data: OCNode['data']) {
  return (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    data.onNodeContextMenu?.(id, e.clientX, e.clientY)
  }
}

function ImageNodeView({ id, data }: NodeProps<OCNode>) {
  const onContextMenu = useCardContextMenu(id, data)
  const src = data.path?.startsWith('/')
    ? fileUrl(data.path)
    : projectFileUrl(data.projectPath || '', data.path || '')
  return (
    <WithHandles>
      <div className="oc-node" onContextMenu={onContextMenu}>
        <Head
          id={id}
          name={data.name}
          type="image"
          renaming={data.renameRequest === id}
          onEditHandled={data.clearRenameRequest}
          onRename={data.onRenameNode}
        />
        <img src={src} alt={data.name} loading="lazy" draggable={false} />
      </div>
    </WithHandles>
  )
}

function TextNodeView({ id, data }: NodeProps<OCNode>) {
  const onContextMenu = useCardContextMenu(id, data)
  return (
    <WithHandles>
      <div className="oc-node" onContextMenu={onContextMenu}>
        <Head
          id={id}
          name={data.name}
          type="text"
          renaming={data.renameRequest === id}
          onEditHandled={data.clearRenameRequest}
          onRename={data.onRenameNode}
        />
        <div className="body">
          <div className="text">{data.text}</div>
        </div>
      </div>
    </WithHandles>
  )
}

function TableNodeView({ id, data }: NodeProps<OCNode>) {
  const onContextMenu = useCardContextMenu(id, data)
  const table = data.table
  return (
    <WithHandles>
      <div className="oc-node" onContextMenu={onContextMenu}>
        <Head
          id={id}
          name={data.name}
          type="table"
          renaming={data.renameRequest === id}
          onEditHandled={data.clearRenameRequest}
          onRename={data.onRenameNode}
        />
        <div className="body">
          {table?.columns?.length ? (
            <table className="oc-table">
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(table.rows || []).map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text">(空表格)</div>
          )}
        </div>
      </div>
    </WithHandles>
  )
}

function FileNodeView({ id, data, type }: NodeProps<OCNode> & { type: string }) {
  const onContextMenu = useCardContextMenu(id, data)
  const abs = data.path?.startsWith('/') ? data.path : `${data.projectPath || ''}/${data.path || ''}`
  return (
    <WithHandles>
      <div className="oc-node" onContextMenu={onContextMenu}>
        <Head
          id={id}
          name={data.name}
          type={type}
          renaming={data.renameRequest === id}
          onEditHandled={data.clearRenameRequest}
          onRename={data.onRenameNode}
        />
        <div className="body">
          {type === 'video' && data.path ? (
            <video src={fileUrl(abs.replace(/\\/g, '/'))} controls preload="metadata" />
          ) : type === 'audio' && data.path ? (
            <audio src={fileUrl(abs.replace(/\\/g, '/'))} controls preload="metadata" style={{ width: '100%' }} />
          ) : (
            <a className="filelink" href={fileUrl(abs.replace(/\\/g, '/'))} target="_blank" rel="noreferrer">
              打开文件：{data.path}
            </a>
          )}
        </div>
      </div>
    </WithHandles>
  )
}

function GroupNodeView({ id, data }: NodeProps<OCNode>) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.name || '分组')

  useEffect(() => {
    if (data.renameRequest === id) {
      setDraft(data.name || '分组')
      setEditing(true)
      data.clearRenameRequest?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.renameRequest])

  const commit = () => {
    setEditing(false)
    const clean = draft.trim()
    if (clean && clean !== data.name) data.onRenameNode?.(id, clean)
  }

  return (
    <div
      className="oc-group"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        data.onNodeContextMenu?.(id, e.clientX, e.clientY)
      }}
    >
      {editing ? (
        <input
          className="oc-group-rename nodrag nopan"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setEditing(false)
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : (
        <div className="oc-group-label">{data.name || '分组'}</div>
      )}
    </div>
  )
}

export const nodeTypes = {
  ocImage: ImageNodeView,
  ocText: TextNodeView,
  ocTable: TableNodeView,
  ocFile: (props: NodeProps<OCNode>) => <FileNodeView {...props} type="file" />,
  ocVideo: (props: NodeProps<OCNode>) => <FileNodeView {...props} type="video" />,
  ocAudio: (props: NodeProps<OCNode>) => <FileNodeView {...props} type="audio" />,
  ocGroup: GroupNodeView
}
