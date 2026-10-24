import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

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


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-quota-'))
app.setPath('userData', root)
app.whenReady().then(async () => {
  app.dock?.hide()
  const { AppDatabase } = await import('../dist-electron/database.js')
  const results = []
  const scenario = (name, run) => {
    const profile = path.join(root, String(results.length))
    fs.mkdirSync(profile)
    app.setPath('userData', profile)
    let date = new Date('2026-10-20T15:59:00.000Z')
    const db = new AppDatabase(() => date)
    const account = db.createAccount()
    db.updateAccount({ id: account.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    const reserve = (key, model = 'seedance_2_0_mini') => db.acceptApiRequest({ requestId: key, source: 'system-test', model, prompt: 'same original fixture prompt' }, account.id)
    const accept = (key) => { db.updateApiRequest({ requestId: key, status: 'running', executionPhase: 'submitting' }); return db.markGenerationAccepted(key) }
    try {
      run({ db, account, reserve, accept, setDate: value => { date = new Date(value) } })
      results.push({ name, ok: true })
    } catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }) }
    finally { db.close() }
  }

  scenario('midnight reset preserves accepted jobs and rebooks queued reservations exactly once', ({ db, account, reserve, accept, setDate }) => {
    reserve('old'); accept('old'); reserve('queued')
    assert.equal(db.getAccount(account.id).quotaRemaining, 6)
    setDate('2026-10-20T16:00:00.000Z')
    assert.ok(db.refreshDailyQuotas() > 0)
    assert.equal(db.getAccount(account.id).quotaRemaining, 8)
    assert.equal(db.getAccount(account.id).quotaDate, '2026-10-21')
    assert.equal(db.getApiRequest('old').quotaDay, '2026-10-20')
    assert.equal(db.getApiRequest('queued').quotaDay, '2026-10-21')
    assert.equal(db.refreshDailyQuotas(), 0)
    assert.equal(db.getAccount(account.id).quotaRemaining, 8)
  })
  scenario('refunds for yesterday never restore credits spent today', ({ db, account, reserve, accept, setDate }) => {
    reserve('yesterday'); accept('yesterday')
    setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas()
    reserve('today', 'seedance_2_0_fast')
    assert.equal(db.refundApiRequestQuota('yesterday'), true)
    assert.equal(db.getAccount(account.id).quotaRemaining, 7)
    assert.equal(db.getAccount(account.id).quotaUsedToday, 3)
    assert.equal(db.refundApiRequestQuota('yesterday'), false)
    assert.equal(db.getAccount(account.id).quotaRemaining, 7)
  })
  scenario('unfunded rollover jobs stay queued and receive released credits without overdraft', ({ db, account, reserve, accept, setDate }) => {
    reserve('started', 'seedance_2_0_fast'); accept('started')
    reserve('first', 'seedance_2_0_fast'); reserve('second', 'seedance_2_0_fast')
    db.updateAccount({ id: account.id, dailyQuotaLimit: 3 })
    setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getAccount(account.id).quotaRemaining, 0)
    assert.equal(db.getApiRequest('first').quotaReserved, true)
    assert.equal(db.getApiRequest('second').quotaReserved, false)
    assert.equal(db.ensureRequestQuota('second'), false)
    db.stopApiRequestAndRefund('first'); db.refreshDailyQuotas()
    assert.equal(db.getApiRequest('second').quotaReserved, true)
    assert.equal(db.getAccount(account.id).quotaRemaining, 0)
    assert.equal(db.getAccount(account.id).quotaUsedToday, 3)
  })
  scenario('atomic admission rolls back duplicate insertion and refuses overdraft', ({ db, account, reserve }) => {
    reserve('one')
    assert.throws(() => reserve('one'))
    assert.equal(db.getAccount(account.id).quotaRemaining, 8)
    for (let index = 2; index <= 5; index++) assert.ok(reserve(String(index)))
    assert.equal(reserve('six'), undefined)
    assert.equal(db.getAccount(account.id).quotaRemaining, 0)
    assert.equal(db.getAccount(account.id).quotaUsedToday, 10)
  })
  scenario('unfunded rollover cancellation retains the old debit date without claiming a current-day refund', ({ db, account, reserve, setDate }) => {
    reserve('funded', 'seedance_2_0_fast'); reserve('unfunded', 'seedance_2_0_fast')
    db.updateAccount({ id: account.id, dailyQuotaLimit: 3 })
    setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getApiRequest('funded').quotaDay, '2026-10-21')
    assert.equal(db.getApiRequest('unfunded').quotaReserved, false)
    assert.equal(db.getApiRequest('unfunded').quotaDay, '2026-10-20')
    assert.match(db.stopApiRequestAndRefund('unfunded').request.message, /原账期 2026-10-20.*不增加今日余额/)
    assert.equal(db.getAccount(account.id).quotaRemaining, 0)
    assert.equal(db.getAccount(account.id).quotaUsedToday, 3)
    assert.equal(db.stopApiRequestAndRefund('unfunded').refunded, false)
  })
  scenario('refunds use stored prices and repeated stops do not refund twice', ({ db, account, reserve }) => {
    reserve('one')
    db.updateSettings({ miniCost: 9 })
    assert.equal(db.stopApiRequestAndRefund('one').refunded, true)
    assert.equal(db.getAccount(account.id).quotaRemaining, 10)
    assert.equal(db.stopApiRequestAndRefund('one').stopped, false)
    assert.equal(db.getAccount(account.id).quotaRemaining, 10)
  })
  scenario('one completion or stop cannot idle an account with other active tasks', ({ db, account, reserve, accept }) => {
    reserve('one'); reserve('two'); reserve('three'); accept('one'); accept('two')
    assert.equal(db.getAccount(account.id).runningTaskCount, 2)
    assert.equal(db.getAccount(account.id).queuedTaskCount, 1)
    db.updateApiRequest({ requestId: 'one', status: 'success', cleanVideoUrl: 'https://example.invalid/one.mp4' })
    assert.equal(db.getAccount(account.id).currentStatus, 'busy')
    db.stopApiRequestAndRefund('three')
    assert.equal(db.getAccount(account.id).runningTaskCount, 1)
    assert.equal(db.getAccount(account.id).queuedTaskCount, 0)
    assert.equal(db.getAccount(account.id).currentStatus, 'busy')
    db.updateApiRequest({ requestId: 'two', status: 'success', cleanVideoUrl: 'https://example.invalid/two.mp4' })
    assert.equal(db.getAccount(account.id).currentStatus, 'idle')
  })
  scenario('identical prompts retain separate source bindings when share URLs change', ({ db, reserve }) => {
    reserve('one'); reserve('two')
    db.updateApiRequest({ requestId: 'one', sourceConversationUrl: 'https://www.doubao.com/chat/one' })
    db.updateApiRequest({ requestId: 'two', sourceConversationUrl: 'https://www.doubao.com/chat/two' })
    db.updateApiRequest({ requestId: 'one', doubaoThreadUrl: 'https://www.doubao.com/thread/shareone' })
    assert.equal(db.getApiRequest('one').sourceConversationUrl, 'https://www.doubao.com/chat/one')
    assert.throws(() => db.updateApiRequest({ requestId: 'two', sourceConversationUrl: 'https://www.doubao.com/chat/one' }), /绑定其他任务/)
    assert.equal(db.getApiRequest('two').sourceConversationUrl, 'https://www.doubao.com/chat/two')
  })
  scenario('multi-day downtime refills only one day and clock rollback cannot refill again', ({ db, account, reserve, accept, setDate }) => {
    reserve('one'); accept('one')
    setDate('2026-10-24T02:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getAccount(account.id).quotaRemaining, 10)
    reserve('today')
    setDate('2026-10-23T01:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getAccount(account.id).quotaRemaining, 8)
    assert.equal(db.getAccount(account.id).quotaDate, '2026-10-24')
    assert.equal(reserve('wrong-clock'), undefined)
  })
  scenario('daily resets do not change third-party paid watermark usage', ({ db, reserve, accept, setDate }) => {
    const settings = db.updateSettings({ watermarkApiToken: 'test-fixture' })
    db.recordWatermarkResponse(settings, { checkedAt: '2026-10-20T00:00:00.000Z', usage: { totalLimit: 100, usedCount: 12, remainingCount: 88 }, error: null })
    reserve('one'); accept('one'); setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas()
    assert.equal(db.getWatermarkStatus().usage.remainingCount, 88)
  })
  scenario('account concurrency settings clamp safely and old global settings remain compatible', ({ db }) => {
    assert.equal(db.getSettings().maxConcurrentTasksPerAccount, 3)
    db.updateSettings({ maxConcurrentTasksPerAccount: 20, maxConcurrentAccounts: 5, dailyResetTime: '13:30' })
    assert.equal(db.getSettings().maxConcurrentTasksPerAccount, 5)
    assert.equal(db.getSettings().maxConcurrentAccounts, 5)
    assert.equal(db.getSettings().dailyResetTime, '00:00')
  })
  scenario('restart resumes only untouched queue entries and never resubmits interrupted work', ({ db, reserve, accept }) => {
    reserve('queued'); reserve('interrupted'); accept('interrupted')
    assert.deepEqual(db.prepareQueueAfterRestart(), ['queued'])
    assert.equal(db.getApiRequest('interrupted').executionPhase, 'paused')
    assert.equal(db.getApiRequest('interrupted').status, 'accepted')
    assert.ok(db.getApiRequest('interrupted').generationAcceptedAt)
  })
  scenario('manual reset cannot overwrite active reservations', ({ db, account, reserve }) => {
    reserve('one')
    assert.throws(() => db.resetAccountQuota(account.id), /预扣额度/)
    assert.throws(() => db.resetAllQuotas(), /额度/)
    assert.equal(db.getAccount(account.id).quotaRemaining, 8)
  })
  scenario('decimal costs persist, account detection keeps fractions and refunds use the original price', ({ db, account, reserve }) => {
    db.updateSettings({ fastCost: 3.5 })
    assert.equal(db.getSettings().fastCost, 3.5)
    const task = reserve('decimal', 'seedance_2_0_fast')
    assert.equal(task.quotaCost, 3.5); assert.equal(db.getAccount(account.id).quotaRemaining, 6.5)
    db.updateAccount({ id: account.id, currentStatus: 'busy', remark: 'remark only' })
    assert.equal(db.getAccount(account.id).quotaRemaining, 6.5); assert.equal(db.getAccount(account.id).quotaUsedToday, 3.5)
    db.updateSettings({ fastCost: 4 }); db.stopApiRequestAndRefund('decimal'); db.stopApiRequestAndRefund('decimal')
    assert.equal(db.getAccount(account.id).quotaRemaining, 10); assert.equal(db.getAccount(account.id).quotaUsedToday, 0)
    const reopened = new AppDatabase(); assert.equal(reopened.getSettings().fastCost, 4); reopened.close()
  })
  scenario('fractional reservations never overdraw and tenths do not accumulate floating residues', ({ db, account, reserve }) => {
    db.updateSettings({ fastCost: 3.5 })
    reserve('a', 'seedance_2_0_fast'); reserve('b', 'seedance_2_0_fast')
    assert.equal(reserve('c', 'seedance_2_0_fast'), undefined); assert.equal(db.getAccount(account.id).quotaRemaining, 3)
    db.stopApiRequestAndRefund('a'); db.stopApiRequestAndRefund('b')
    db.updateSettings({ miniCost: 1.1 })
    for (let i = 0; i < 9; i++) reserve('tenths-' + i)
    assert.equal(db.getAccount(account.id).quotaRemaining, 0.1); assert.equal(db.getAccount(account.id).quotaUsedToday, 9.9)
    assert.equal(reserve('overdraw'), undefined)
    for (let i = 0; i < 9; i++) db.stopApiRequestAndRefund('tenths-' + i)
    assert.equal(db.getAccount(account.id).quotaRemaining, 10); assert.equal(db.getAccount(account.id).quotaUsedToday, 0)
  })
  scenario('decimal cross-day refunds cannot change the new day balance', ({ db, account, reserve, accept, setDate }) => {
    db.updateSettings({ fastCost: 3.5 }); reserve('yesterday', 'seedance_2_0_fast'); accept('yesterday')
    setDate('2026-10-20T16:00:00.000Z'); db.refreshDailyQuotas(); reserve('today', 'seedance_2_0_fast')
    db.stopApiRequestAndRefund('yesterday'); assert.equal(db.getAccount(account.id).quotaRemaining, 6.5)
    db.stopApiRequestAndRefund('today'); assert.equal(db.getAccount(account.id).quotaRemaining, 10)
  })
  scenario('decimal failover transfers the exact stored reservation atomically', ({ db, account }) => {
    db.updateSettings({ fastCost: 3.5 })
    const task = db.acceptApiRequest({ requestId: 'move-decimal', model: 'seedance_2_0_fast', prompt: 'original fixture' })
    const other = db.createAccount(); db.updateAccount({ id: other.id, loginStatus: 'logged_in', currentStatus: 'idle' })
    db.updateSettings({ fastCost: 4 })
    const next = db.handleDailyQuotaExhaustion(task.requestId, 0, '今日视频生成免费次数用完了，你明天再来找我继续吧。')[0]
    assert.equal(next.accountId, other.id); assert.equal(next.quotaCost, 3.5)
    assert.equal(db.getAccount(account.id).quotaRemaining, 10); assert.equal(db.getAccount(other.id).quotaRemaining, 6.5)
    db.stopApiRequestAndRefund(task.requestId); assert.equal(db.getAccount(other.id).quotaRemaining, 10)
  })
  console.log('QUOTA_RESULTS ' + JSON.stringify(results))
  try { rmSyncWithRetry(root, { recursive: true, force: true }) }
  catch (cleanupError) { console.error('PROFILE_RM_FAIL', cleanupError.code, String(cleanupError.message).slice(0, 140)) }
  app.exit(results.every(item => item.ok) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
