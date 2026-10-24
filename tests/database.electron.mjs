import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import http from 'node:http'

// Windows 下 Chromium profile（如 DIPS）在窗口销毁后仍被短暂锁定，直接删目录会 EBUSY，重试吸收释放延迟
function rmSyncWithRetry(target, options, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      return fs.rmSync(target, options)
    } catch (error) {
      if (i >= attempts - 1 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
}


const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-isolated-db-'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  app.dock?.hide()
  let exitCode = 0
  try {
  const file = path.join(profile, 'doubao-manager.sqlite3')
  const legacy = new Database(file)
  legacy.exec(`CREATE TABLE api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'local',
    model TEXT NOT NULL, account_id INTEGER, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  legacy.exec(`CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, partition TEXT NOT NULL UNIQUE,
    login_status TEXT NOT NULL DEFAULT 'logged_in', daily_quota_limit INTEGER NOT NULL DEFAULT 10,
    quota_remaining INTEGER NOT NULL DEFAULT 4, quota_used_today INTEGER NOT NULL DEFAULT 6,
    last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); INSERT INTO accounts(name,partition,created_at,updated_at) VALUES ('legacy','persist:doubao_account_001','2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z');`)
  legacy.close()
  const { AppDatabase } = await import('../dist-electron/database.js')
  const database = new AppDatabase()
  assert.equal(database.getAccount(1).quotaRemaining, 4)
  assert.equal(database.getAccount(1).quotaUsedToday, 6)
  assert.ok(database.getAccount(1).quotaDate)
  const settings = database.updateSettings({ apiServiceEnabled: false, executorEnabled: false, watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.recordWatermarkResponse(settings, { checkedAt: new Date().toISOString(), usage: { totalLimit: 100, usedCount: 12, remainingCount: 88 }, error: null })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)
  database.updateSettings({ watermarkApiToken: 'fixture-B' })
  assert.equal(database.getWatermarkStatus().usage, null)
  database.updateSettings({ watermarkApiToken: 'fixture-A' })
  assert.equal(database.getWatermarkStatus().usage.remainingCount, 88)

  const account = database.createAccount({ remark: 'isolated fixture' })
  const failure = { stage: 'watermark', code: 'quota_exhausted', title: '去水印次数已耗尽', detail: '次数已耗尽', suggestion: '补充次数后恢复结果', retryable: false }
  database.createApiRequest({ requestId: 'isolated-failure', model: 'seedance_2_0_mini', accountId: account.id, status: 'running', prompt: 'fixture' })
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'failed', message: '次数已耗尽', error: failure, doubaoThreadUrl: 'https://www.doubao.com/thread/fixture' })
  assert.deepEqual(database.getApiRequest('isolated-failure').error, failure)
  database.updateApiRequest({ requestId: 'isolated-failure', status: 'running', message: '恢复结果' })
  assert.equal(database.getApiRequest('isolated-failure').error, null)
  for (let index = 0; index < 103; index++) {
    const requestId = `isolated-success-${index}`
    database.createApiRequest({ requestId, model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' })
    database.updateApiRequest({ requestId, status: 'success', cleanVideoUrl: 'https://example.invalid/video.mp4' })
  }
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 1)
  assert.equal(database.getRequestStats(start.toISOString(), end.toISOString()).todaySuccess, 103)
  assert.equal(database.listApiRequests(100).length, 100)
  const inspect = new Database(file, { readonly: true })
  const scopes = inspect.prepare('SELECT scope, value FROM service_state').all()
  assert.equal(JSON.stringify(scopes).includes('fixture-A'), false)
  const tokenTime = inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at
  database.updateSettings({ outputDir: path.join(profile, 'output') })
  assert.equal(inspect.prepare("SELECT updated_at FROM settings WHERE key='watermarkApiToken'").get().updated_at, tokenTime)
  inspect.close()
  const { waitForSubmissionStarted } = await import('../dist-electron/executor.js')
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } })
  const check = async (html) => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return waitForSubmissionStarted(win, 'seedance_2_0_mini', '新对话', '用户的原始提示词', 1)
  }
  const promiseOnly = await check('<p>已生成代码</p><p>正在渲染，请等待成片输出。</p><textarea></textarea>')
  assert.equal(promiseOnly.confirmed || promiseOnly.pending, false)
  const nativeTask = await check('<div class="video-task">视频生成中</div><textarea></textarea>')
  assert.equal(nativeTask.pending, true)
  const formal = await check('<p>本次使用 Seedance 2.0 Mini 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。</p><textarea></textarea>')
  assert.equal(formal.confirmed, true)
  const manualInput = await check('<p>正在渲染，请等待成片输出。</p><textarea>手动输入中的文字</textarea><button aria-label="停止回答">停止</button>')
  assert.equal(manualInput.hasDraft, true)
  assert.equal(manualInput.responding, true)
  win.destroy()
  const { submitPromptAndWait } = await import('../dist-electron/executor.js')
  const windows = [0, 1, 2].map(() => new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, backgroundThrottling: false, partition: 'persist:parallel-test' } }))
  const prompts = ['same original prompt', 'different original prompt', 'same original prompt']
  const html = prompt => `<textarea style="width:700px;height:80px">${prompt}</textarea><div id="reply"></div><script>
    document.querySelector('textarea').focus();
    document.addEventListener('keydown', event => { if(event.key === 'Enter') { window.sent = document.querySelector('textarea').value; document.querySelector('textarea').value = ''; } });
  </script>`
  await Promise.all(windows.map((window, index) => window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(prompts[index])))))
  const submissions = windows.map((window, index) => submitPromptAndWait(window, 'seedance_2_0_mini', prompts[index]))
  let sent = []
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    sent = await Promise.all(windows.map(window => window.webContents.executeJavaScript('window.sent || null')))
    if (sent.every(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.deepEqual(sent, prompts, 'All three windows must receive their own send before any acknowledgement')
  await Promise.all(windows.map(window => window.webContents.executeJavaScript(`document.getElementById('reply').innerText = '本次使用 Seedance 2.0 Mini 生成，预计等待 10 分钟。视频生成好后，我会主动发送给你。'`)))
  assert.deepEqual(await Promise.all(submissions), ['confirmed', 'confirmed', 'confirmed'])
  windows.forEach(window => window.destroy())
  const seen = []
  let origin
  const mock = http.createServer((req, res) => {
    if (req.url.startsWith('/video.mp4')) {
      res.writeHead(206, { 'content-type': 'video/mp4' }); res.end(Buffer.from('00000018667479706d703432', 'hex'))
    } else {
      seen.push([req.url.split('?')[0], req.headers.authorization])
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 200, data: { url: `${origin}/video.mp4`, usage: { remainingCount: 91 } } }))
    }
  })
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${mock.address().port}`
    const oldSettings = database.updateSettings({ watermarkApiUrl: `${origin}/old`, watermarkApiToken: 'fixture-old' })
    const task = database.createApiRequest({ requestId: 'executor-live-settings', model: 'seedance_2_0_mini', status: 'running', prompt: 'fixture' })
    database.updateSettings({ watermarkApiUrl: `${origin}/new`, watermarkApiToken: 'fixture-new' })
    const { DoubaoExecutor } = await import('../dist-electron/executor.js')
    const executor = new DoubaoExecutor(database, () => {}, (settings, event) => database.recordWatermarkResponse(settings, event))
    await executor.resolveCleanVideoWithProgress(task, oldSettings, 'https://www.doubao.com/thread/fixture', 1)
    assert.deepEqual(seen, [['/new', 'fixture-new']])
    assert.equal(database.getWatermarkStatus().usage.remainingCount, 91)
    database.recordWatermarkResponse(oldSettings, { checkedAt: new Date().toISOString(), usage: { remainingCount: 0 }, error: failure })
    assert.equal(database.getWatermarkStatus().usage.remainingCount, 91, 'Late old-token responses cannot replace the current token balance')
  } finally { await new Promise(resolve => mock.close(resolve)) }
  console.log('ISOLATED_DATABASE_OK')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  try { rmSyncWithRetry(profile, { recursive: true, force: true }) }
  catch (cleanupError) { console.error('PROFILE_RM_FAIL', cleanupError.code, String(cleanupError.message).slice(0, 140)) }
}
  app.exit(exitCode)
})
