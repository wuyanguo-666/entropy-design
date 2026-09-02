import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { startServer } from './server'
import { stopAgent } from './agent'
import { initLogging, log, tailLogs } from './log'
import { setupAutoUpdater } from './updater'

let serverPort = 8765
/** One-time API token for this run: gates /api/*, /files and the WS socket. */
const serverToken = crypto.randomUUID()

// electron-builder writes productName into the packaged package.json and Electron
// prefers productName for app.getName() — lock userData to %APPDATA%/entropy-design
// so the data folder path stays stable in packaged builds.
app.setName('entropy-design')

initLogging()
process.on('uncaughtException', (e) => {
  log('error', 'fatal', `uncaughtException: ${e.stack || String(e)}`)
})
process.on('unhandledRejection', (r) => {
  log('error', 'fatal', `unhandledRejection: ${String((r as Error)?.stack || r)}`)
})
log('info', 'boot', `Entropy Design v${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform})`)

function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => {
      // preferred port taken — ask the OS for a random free one
      const fallback = net.createServer()
      fallback.once('error', () => resolve(preferred))
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address()
        const port = typeof addr === 'object' && addr ? addr.port : preferred
        // close the probe BEFORE handing the port out, or the real listen() hits EADDRINUSE
        fallback.close(() => resolve(port))
      })
    })
    srv.listen(preferred, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : preferred
      srv.close(() => resolve(port))
    })
  })
}

function createWindow(): BrowserWindow {
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#fafafa',
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  // bind with retries: a leftover instance may hold the preferred port
  for (let attempt = 0; ; attempt++) {
    try {
      await startServer(serverPort, serverToken)
      log('info', 'boot', `local server listening on 127.0.0.1:${serverPort} (attempt ${attempt + 1})`)
      break
    } catch (e) {
      if (attempt >= 4) {
        log('error', 'boot', `server bind failed on ${serverPort}: ${String((e as Error).message || e)}`)
        // selectable text: users can copy the whole diagnostic block into a bug report
        dialog.showErrorBox(
          'Entropy Design 启动失败',
          [
            `本地服务端口绑定失败（${serverPort}）：${String((e as Error).message || e)}`,
            '请关闭残留的 Entropy Design/electron 进程后重试。',
            '',
            `— 诊断信息 —`,
            `版本: ${app.getVersion()} | Electron ${process.versions.electron} | ${process.platform} ${process.arch}`,
            `数据目录: ${app.getPath('userData')}`,
            `日志尾部:`,
            tailLogs(20)
          ].join('\n')
        )
        app.quit()
        return
      }
      serverPort = await findFreePort(0)
    }
  }

  ipcMain.handle('server-port', () => serverPort)
  ipcMain.handle('server-token', () => serverToken)

  createWindow()
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  log('info', 'lifecycle', 'all windows closed')
  void stopAgent()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  log('info', 'lifecycle', 'before-quit: stopping agent')
  void stopAgent()
})
