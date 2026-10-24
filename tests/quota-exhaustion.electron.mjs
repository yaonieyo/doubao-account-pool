import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { app, BrowserWindow } from 'electron'
import SQLite from 'better-sqlite3'

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


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-exhaustion-'))
app.setPath('userData', root)
app.on('window-all-closed', () => {})
const reply = '今日视频生成免费次数用完了，你明天再来找我继续吧。'
app.whenReady().then(async () => {
  app.dock?.hide()
  const { AppDatabase, AssignmentChangedError } = await import('../dist-electron/database.js')
  const results = []
  const scenario = (name, run) => {
    const profile = path.join(root, String(results.length)); fs.mkdirSync(profile); app.setPath('userData', profile)
    let time = new Date('2026-10-20T07:00:00.000Z')
    const clock = () => time
    const db = new AppDatabase(clock), a = db.createAccount(), b = db.createAccount()
    db.updateAccount({ id: a.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    const reserve = (key, pinned = false) => db.acceptApiRequest({ requestId: key, model: 'seedance_2_0_mini', prompt: 'original fixture prompt',
      aspectRatio: '9:16', referenceImagePath: '/fixture/reference.png', callbackUrl: 'http://127.0.0.1/fixture-callback' }, pinned ? a.id : undefined)
    const enableB = () => db.updateAccount({ id: b.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    const sent = key => db.updateApiRequest({ requestId: key, assignmentRevision: 0, status: 'running', executionPhase: 'submitting', submissionSentAt: time.toISOString() })
    try { run({ db, a, b, reserve, enableB, sent, profile, clock, setDate: value => { time = new Date(value) } }); results.push({ name, ok: true }) }
    catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }) }
    finally { db.close() }
  }
  scenario('refund does not reopen a provider-exhausted account or fabricate local consumption', ({ db, a, reserve }) => {
    reserve('one'); db.markDailyQuotaExhausted(a.id, reply); db.refundApiRequestQuota('one', 0)
    const account = db.getAccount(a.id)
    assert.equal(account.quotaRemaining, 10); assert.equal(account.quotaUsedToday, 0)
    assert.equal(account.availableQuota, 0); assert.equal(account.dailyQuotaExhausted, true)
    assert.equal(db.findAvailableAccount('seedance_2_0_mini'), undefined)
  })
  scenario('refresh, login detection, manual reset and restart cannot clear today exhaustion', ({ db, a, profile, clock }) => {
    db.markDailyQuotaExhausted(a.id, reply); db.refreshDailyQuotas(); db.resetAccountQuota(a.id)
    db.updateAccount({ id: a.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    const reopened = new AppDatabase(clock)
    assert.equal(reopened.getAccount(a.id).availableQuota, 0)
    assert.equal(reopened.getAccount(a.id).quotaExhaustedReason, reply)
    reopened.close()
  })
  scenario('Beijing midnight clears only the old generation flag, not paid watermark usage', ({ db, a, setDate }) => {
    const settings = db.updateSettings({ watermarkApiToken: 'fixture-only' })
    db.recordWatermarkResponse(settings, { checkedAt: '2026-10-20T07:00:00.000Z', usage: { totalLimit: 100, usedCount: 12, remainingCount: 88 }, error: null })
    db.markDailyQuotaExhausted(a.id, reply); setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getAccount(a.id).dailyQuotaExhausted, false); assert.equal(db.getAccount(a.id).availableQuota, 10)
    assert.equal(db.getWatermarkStatus().usage.remainingCount, 88)
  })
  scenario('explicit refusal moves the same request and parameters atomically without a failed status', ({ db, a, b, reserve, enableB, sent }) => {
    const original = reserve('one'); sent('one'); enableB()
    const changed = db.handleDailyQuotaExhaustion('one', 0, reply)
    const next = changed.find(task => task.requestId === 'one')
    assert.equal(next.status, 'accepted'); assert.equal(next.accountId, b.id); assert.equal(next.assignmentRevision, 1)
    for (const key of ['requestId', 'prompt', 'model', 'aspectRatio', 'referenceImagePath', 'callbackUrl']) assert.equal(next[key], original[key])
    assert.equal(next.submissionSentAt, null); assert.equal(next.sourceConversationUrl, null)
    assert.equal(db.getAccount(a.id).quotaRemaining, 10); assert.equal(db.getAccount(b.id).quotaRemaining, 8)
    assert.equal(next.quotaRefunded, false); assert.equal(next.quotaReserved, true)
  })
  scenario('a fresh refusal just after midnight survives delayed local rollover', ({ db, a, b, reserve, enableB, sent, setDate }) => {
    reserve('midnight'); sent('midnight'); enableB()
    setDate('2026-10-20T16:00:01.000Z')
    const changed = db.handleDailyQuotaExhaustion('midnight', 0, reply)
    assert.equal(db.getAccount(a.id).dailyQuotaExhausted, true)
    assert.equal(db.getAccount(a.id).quotaExhaustedDate, '2026-10-21')
    assert.equal(db.getAccount(a.id).availableQuota, 0)
    assert.equal(changed[0].accountId, b.id)
    assert.equal(db.getAccount(b.id).quotaRemaining, 8)
  })
  scenario('stale assignments cannot update, refund, accept or move a new assignment', ({ db, b, reserve, enableB, sent }) => {
    reserve('one'); sent('one'); enableB(); db.handleDailyQuotaExhaustion('one', 0, reply)
    assert.throws(() => db.updateApiRequest({ requestId: 'one', assignmentRevision: 0, status: 'success' }), AssignmentChangedError)
    assert.throws(() => db.refundApiRequestQuota('one', 0), AssignmentChangedError)
    assert.throws(() => db.markGenerationAccepted('one', 0), AssignmentChangedError)
    assert.throws(() => db.rerouteUnacceptedRequest('one', 0, true), AssignmentChangedError)
    assert.equal(db.getAccount(b.id).quotaRemaining, 8); assert.equal(db.getApiRequest('one').status, 'accepted')
  })
  scenario('only untouched queued work moves; sent, accepted and completed siblings are preserved', ({ db, a, b, reserve, enableB, sent }) => {
    reserve('trigger'); reserve('queued'); reserve('sent'); reserve('accepted'); reserve('done')
    sent('trigger'); sent('sent'); sent('accepted'); db.markGenerationAccepted('accepted', 0)
    db.updateApiRequest({ requestId: 'done', status: 'success', cleanVideoUrl: 'https://example.invalid/done.mp4' })
    enableB(); db.handleDailyQuotaExhaustion('trigger', 0, reply)
    assert.equal(db.getApiRequest('queued').accountId, b.id)
    assert.equal(db.getApiRequest('sent').accountId, a.id)
    assert.equal(db.getApiRequest('accepted').accountId, a.id)
    assert.equal(db.getApiRequest('accepted').status, 'running')
    assert.equal(db.getApiRequest('done').status, 'success')
    assert.equal(db.getAccount(a.id).runningTaskCount, 2)
    const remaining = db.getAccount(a.id).quotaRemaining
    db.handleDailyQuotaExhaustion('accepted', 0, reply)
    assert.equal(db.getApiRequest('accepted').status, 'running')
    assert.equal(db.getAccount(a.id).quotaRemaining, remaining)
  })
  scenario('pinned account requests fail clearly without secretly changing accounts', ({ db, a, b, reserve, enableB, sent }) => {
    reserve('one', true); sent('one'); enableB()
    const task = db.handleDailyQuotaExhaustion('one', 0, reply)[0]
    assert.equal(task.status, 'failed'); assert.equal(task.accountId, a.id); assert.equal(task.requestedAccountId, a.id)
    assert.equal(task.error.code, 'doubao_daily_quota_exhausted'); assert.match(task.message, /指定了账号/)
    assert.equal(db.getAccount(b.id).quotaRemaining, 10)
  })
  scenario('no alternative fails and refunds once; duplicate notification cannot return points again', ({ db, a, reserve, sent }) => {
    reserve('one'); sent('one')
    const changed = db.handleDailyQuotaExhaustion('one', 0, reply)
    assert.equal(changed[0].status, 'failed'); assert.match(changed[0].message, /暂无其他/)
    assert.equal(db.getAccount(a.id).quotaRemaining, 10)
    assert.equal(db.handleDailyQuotaExhaustion('one', 0, reply).length, 0)
    assert.equal(db.getAccount(a.id).quotaRemaining, 10)
  })
  scenario('failover keeps stored prices and stopping only refunds the new reservation once', ({ db, a, b, reserve, enableB, sent }) => {
    reserve('one'); sent('one'); enableB(); db.updateSettings({ miniCost: 9 })
    db.handleDailyQuotaExhaustion('one', 0, reply)
    assert.equal(db.getApiRequest('one').quotaCost, 2); assert.equal(db.getAccount(b.id).quotaRemaining, 8)
    assert.equal(db.stopApiRequestAndRefund('one').refunded, true)
    assert.equal(db.stopApiRequestAndRefund('one').refunded, false)
    assert.equal(db.getAccount(a.id).availableQuota, 0); assert.equal(db.getAccount(b.id).quotaRemaining, 10)
  })
  scenario('cross-day failover refunds yesterday only to its record and charges the new account today', ({ db, a, b, reserve, enableB, sent, setDate }) => {
    reserve('one'); sent('one'); db.updateApiRequest({ requestId: 'one', executionPhase: 'paused' })
    setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas(); enableB()
    db.handleDailyQuotaExhaustion('one', 0, reply)
    assert.equal(db.getAccount(a.id).quotaRemaining, 10)
    assert.equal(db.getAccount(b.id).quotaRemaining, 8)
    assert.equal(db.getApiRequest('one').quotaDay, '2026-10-21')
  })
  scenario('an assignment never returns to an exhausted account, including after restart', ({ db, a, b, reserve, enableB, sent, clock }) => {
    reserve('one'); sent('one'); enableB(); db.handleDailyQuotaExhaustion('one', 0, reply)
    db.updateApiRequest({ requestId: 'one', assignmentRevision: 1, status: 'running', executionPhase: 'submitting', submissionSentAt: clock().toISOString() })
    const task = db.handleDailyQuotaExhaustion('one', 1, reply)[0]
    assert.equal(task.status, 'failed'); assert.equal(task.accountId, b.id)
    const reopened = new AppDatabase(clock)
    assert.equal(reopened.getAccount(a.id).availableQuota, 0); assert.equal(reopened.getAccount(b.id).availableQuota, 0)
    reopened.close()
  })
  scenario('migration repairs today failures without refunds, retries or reviving historical tasks', ({ db, a, profile }) => {
    const fixture = new SQLite(path.join(profile, 'doubao-manager.sqlite3'))
    db.createApiRequest({ requestId: 'old-failure', accountId: a.id, model: 'seedance_2_0_mini', status: 'failed', prompt: 'fixture', message: reply })
    fixture.prepare("UPDATE api_requests SET error_json = ?, created_at = ?, finished_at = ? WHERE request_id = 'old-failure'")
      .run(JSON.stringify({ stage: 'unknown', code: 'unknown', title: '任务未完成' }), '2026-10-20T06:00:00.000Z', '2026-10-20T06:01:00.000Z')
    fixture.prepare("DELETE FROM settings WHERE key='doubaoDailyQuotaV1'").run(); db.migrate()
    assert.equal(db.getAccount(a.id).availableQuota, 0); assert.equal(db.getAccount(a.id).quotaRemaining, 10)
    assert.equal(db.getApiRequest('old-failure').status, 'failed')
    assert.equal(db.getApiRequest('old-failure').error.code, 'doubao_daily_quota_exhausted')
    db.migrate(); assert.equal(db.getAccount(a.id).quotaRemaining, 10)
    fixture.close()
  })
  scenario('migration ignores yesterday, watermark and historical recovery errors', ({ db, a, profile }) => {
    const fixture = new SQLite(path.join(profile, 'doubao-manager.sqlite3'))
    for (const key of ['yesterday', 'watermark', 'recovery']) db.createApiRequest({ requestId: key, accountId: a.id, model: 'seedance_2_0_mini', status: 'failed', prompt: 'fixture', message: key === 'recovery' ? '恢复结果失败：' + reply : reply })
    fixture.prepare("UPDATE api_requests SET created_at = ?, finished_at = ?").run('2026-10-20T06:00:00.000Z', '2026-10-20T06:01:00.000Z')
    fixture.prepare("UPDATE api_requests SET created_at='2026-10-19T06:00:00.000Z', finished_at='2026-10-19T06:01:00.000Z' WHERE request_id='yesterday'").run()
    fixture.prepare("UPDATE api_requests SET error_json=? WHERE request_id='watermark'").run(JSON.stringify({ stage: 'watermark', code: 'quota_exhausted' }))
    fixture.prepare("DELETE FROM settings WHERE key='doubaoDailyQuotaV1'").run(); db.migrate()
    assert.equal(db.getAccount(a.id).dailyQuotaExhausted, false)
    fixture.close()
  })
  const profile = path.join(root, 'executor'); fs.mkdirSync(profile); app.setPath('userData', profile)
  const db = new AppDatabase(), windows = [], callbacks = [], starts = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { callbacks.push(JSON.parse(body)); res.end('ok') })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { DoubaoExecutor, submitPromptAndWait } = await import('../dist-electron/executor.js')
    const a = db.createAccount(), b = db.createAccount()
    db.updateAccount({ id: a.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    db.updateSettings({ executorEnabled: true, maxConcurrentAccounts: 5, maxConcurrentTasksPerAccount: 3 })
    const task = db.acceptApiRequest({ requestId: 'same-executor-id', model: 'seedance_2_0_mini', prompt: 'unchanged original fixture prompt', aspectRatio: '9:16',
      callbackUrl: `http://127.0.0.1:${server.address().port}/callback` })
    db.updateAccount({ id: b.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    const executor = new DoubaoExecutor(db, () => {})
    // Only replace provider preparation/completion; use real DOM sending, refusal handling,
    // database transactions, scheduler retries and HTTP callbacks in between.
    executor.execute = async id => {
      const current = db.getApiRequest(id); starts.push(current.accountId)
      if (current.accountId === a.id) {
        const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, backgroundThrottling: false } }); windows.push(win)
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<textarea style="width:700px;height:80px">${current.prompt}</textarea><div id="reply"></div><script>
          document.querySelector('textarea').focus();document.addEventListener('keydown', event => {if(event.key === 'Enter') {document.querySelector('textarea').value='';document.querySelector('#reply').textContent=${JSON.stringify(reply)};}});
        </script>`))
        try {
          await submitPromptAndWait(win, current.model, current.prompt, async message => executor.updateProgress({ requestId: id, assignmentRevision: current.assignmentRevision,
            status: 'running', executionPhase: 'submitting', message, submissionSentAt: new Date().toISOString() }))
          assert.fail('The provider refusal must be detected')
        } catch (error) {
          assert.match(error.message, /今日视频生成免费次数用完/)
          return executor.handleQuotaRejection(current, error.message)
        } finally { win.destroy() }
      }
      assert.equal(current.requestId, task.requestId); assert.equal(current.prompt, task.prompt); assert.equal(current.aspectRatio, task.aspectRatio)
      db.markGenerationAccepted(id, current.assignmentRevision)
      await executor.updateProgress({ requestId: id, assignmentRevision: current.assignmentRevision, status: 'success', message: 'fixture provider completed', cleanVideoUrl: 'https://example.invalid/fixture.mp4' })
    }
    executor.enqueue(task.requestId)
    const deadline = Date.now() + 12000
    while (Date.now() < deadline && !callbacks.some(item => item.status === 'success')) await new Promise(resolve => setTimeout(resolve, 25))
    assert.deepEqual(starts, [a.id, b.id]); assert.equal(db.getApiRequest(task.requestId).status, 'success')
    assert.ok(callbacks.some(item => item.status === 'accepted' && /自动换/.test(item.message)))
    assert.equal(callbacks.some(item => item.status === 'failed'), false)
    assert.ok(callbacks.every(item => item.requestId === task.requestId))
    assert.equal(db.getAccount(a.id).quotaRemaining, 10); assert.equal(db.getAccount(a.id).availableQuota, 0)
    assert.equal(db.getAccount(b.id).quotaRemaining, 8)
    results.push({ name: 'real DOM quota refusal retries same ID through executor scheduler and ordered HTTP callbacks', ok: true })
  } catch (error) { results.push({ name: 'real DOM quota refusal retries same ID through executor scheduler and ordered HTTP callbacks', ok: false, error: error.stack }) }
  finally { windows.forEach(win => { if (!win.isDestroyed()) win.destroy() }); await new Promise(resolve => server.close(resolve)); db.close() }
  console.log('EXHAUSTION_RESULTS ' + JSON.stringify(results))
  try { rmSyncWithRetry(root, { recursive: true, force: true }) }
  catch (cleanupError) { console.error('PROFILE_RM_FAIL', cleanupError.code, String(cleanupError.message).slice(0, 140)) }; app.exit(results.every(item => item.ok) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
