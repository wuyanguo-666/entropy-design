import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { log } from './log'

/**
 * Silent-failure auto-update (P2-2): checks GitHub Releases once per launch
 * (delayed, so boot stays fast), never steals focus, and only downloads after the
 * user agrees. Network/feed failures go to the log file — an offline user should
 * never see an update error. The feed (publish:) lives in electron-builder.yml.
 */

let configured = false

export function setupAutoUpdater(): void {
  if (!app.isPackaged || configured) return
  configured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    log('info', 'updater', `update available: ${info.version}`)
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['稍后', '立即下载'],
        defaultId: 1,
        title: 'Entropy Design',
        message: `发现新版本 ${info.version}`,
        detail: '后台下载完成后，将在下次退出时自动安装。'
      })
      .then(({ response }) => {
        if (response === 1) void autoUpdater.downloadUpdate().catch((e) => log('warn', 'updater', `download failed: ${String(e?.message || e)}`))
      })
  })
  autoUpdater.on('update-downloaded', (info) => log('info', 'updater', `v${info.version} downloaded; will install on quit`))
  autoUpdater.on('error', (e) => log('warn', 'updater', `check/download error (ignored): ${String(e?.message || e)}`))
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {})
  }, 15000)
}

/** Manual check (Settings → 检查更新). Returns a user-presentable outcome. */
export async function checkForUpdatesNow(): Promise<{ ok: boolean; error?: string; version?: string }> {
  if (!app.isPackaged) return { ok: false, error: '开发模式不检查更新' }
  try {
    const r = await autoUpdater.checkForUpdates()
    return r?.updateInfo ? { ok: true, version: r.updateInfo.version } : { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}
