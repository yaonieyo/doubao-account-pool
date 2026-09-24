import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountTaskScheduler } from '../dist-electron/account-scheduler.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('runs different accounts concurrently', async () => {
  const gates = new Map([[1, deferred()], [2, deferred()]])
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      await gates.get(item.accountId).promise
    },
  )

  scheduler.enqueue({ key: 'one', accountId: 1 })
  scheduler.enqueue({ key: 'two', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started.sort(), ['one', 'two'])

  gates.get(1).resolve()
  gates.get(2).resolve()
})

test('keeps tasks for the same account sequential', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 2,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 1 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('honors the configured concurrency limit', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 2 })
  await nextTurn()
  assert.deepEqual(started, ['first'])

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])
})

test('removes a cancelled pending task without running it', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'cancelled', accountId: 2 })
  await nextTurn()
  assert.equal(scheduler.isActive('first'), true)
  assert.equal(scheduler.cancel('cancelled'), true)

  firstGate.resolve()
  await nextTurn()
  assert.deepEqual(started, ['first'])
  assert.equal(scheduler.cancel('cancelled'), false)
})

test('releases concurrency immediately when an active task is cancelled', async () => {
  const firstGate = deferred()
  const started = []
  const scheduler = new AccountTaskScheduler(
    () => 1,
    async (item) => {
      started.push(item.key)
      if (item.key === 'first') await firstGate.promise
    },
  )

  scheduler.enqueue({ key: 'first', accountId: 1 })
  scheduler.enqueue({ key: 'second', accountId: 2 })
  await nextTurn()
  assert.equal(scheduler.cancel('first'), true)
  await nextTurn()
  assert.deepEqual(started, ['first', 'second'])

  firstGate.resolve()
})
