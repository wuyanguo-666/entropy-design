import http from 'node:http'
// 1x1 red PNG — returned by the mock image endpoints (generations + edits)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const server = http.createServer((req, res) => {
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    return
  }
  if (req.url.includes('/images/generations') || req.url.includes('/images/edits')) {
    // drain the request body (multipart for edits) so the socket closes cleanly
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] }))
    })
    return
  }
  if (req.url.includes('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const msgs = parsed.messages || []
      // non-streaming vision request (media_analyse): plain JSON reply, not SSE
      if (parsed.stream === false) {
        const hasImage = msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'))
        const content = hasImage
          ? '【mock 视觉描述】画面为测试片：纯色背景，无明显主体运动。镜头静止，光线均匀。'
          : '【mock 文本回复】'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', created: 1, model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        }))
        return
      }
      const tools = msgs.filter((m) => m.role === 'tool')
      const lastToolText = tools.length ? String(tools[tools.length - 1]?.content ?? '') : ''
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const userText = String(
        typeof lastUser?.content === 'string'
          ? lastUser.content
          : (lastUser?.content || []).map((p) => p?.text || '').join(' ')
      )
      const chunk = (id, delta, finish) =>
        JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o) => res.write(`data: ${o}\n\n`)
      const call = (id, name, args) => {
        send(chunk(id, { role: 'assistant', content: '' }))
        send(chunk(id, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }))
        send(chunk(id, {}, 'tool_calls'))
      }
      const text = (id, content) => {
        send(chunk(id, { role: 'assistant', content }))
        send(chunk(id, {}, 'stop'))
      }
      if (!tools.length) {
        if (userText.includes('视频')) {
          // exercise the ask_user question card path
          call('call1', 'entropy_ask_user', {
            questions: [
              { question: '画面比例', options: ['16:9（推荐）', '9:16', '1:1'] },
              { question: '时长', options: ['5 秒（推荐）', '10 秒'] },
              { question: '是否需要配音', options: ['不需要（推荐）', '需要'] }
            ]
          })
        } else {
          call('call1', 'entropy_canvas_node_add_text', { name: 'mock计划', text: '这是 mock agent 创建的计划' })
        }
      } else if (lastToolText.includes('user answered')) {
        call('call2', 'entropy_canvas_node_add_text', { name: 'mock计划', text: '已按你在卡片里的选择出计划（模拟）：16:9 / 5 秒 / 不配音' })
      } else if (lastToolText.includes('name="mock计划"')) {
        // chain step 2: first-frame sample node, lineage-linked to the plan node
        const planId = (/id=([0-9a-f-]+)/.exec(lastToolText) || [])[1]
        call('call3', 'entropy_canvas_node_add_text', {
          name: '首帧样例',
          text: '霓虹雨夜街头，舞者剪影起手式（模拟首帧描述）',
          ...(planId ? { source_node_id: planId } : {})
        })
      } else if (lastToolText.includes('name="首帧样例"')) {
        text('call4', '完成！画布上：`mock计划` → `首帧样例` 已连线（lineage）。确认首帧后就可以接视频生成了（mock 到此为止）。')
      } else if (lastToolText.includes('text node created')) {
        text('call3', '完成！已在画布创建计划节点，文件名：`mock计划`')
      } else if (lastToolText.includes('dismissed')) {
        text('call3', '你取消了提问卡片。告诉我想怎么调整，我再继续。')
      } else {
        text('call3', '完成！（mock）')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(4598, '127.0.0.1', () => console.log('mock llm on 4598'))
