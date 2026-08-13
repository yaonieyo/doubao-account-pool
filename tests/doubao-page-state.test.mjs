import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsPromptSignature,
  doubaoVideoModelFromText,
  doubaoVideoModelLabel,
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractNewDoubaoReply,
  extractDoubaoShareUrl,
  getNewDoubaoVideoUrls,
  hasNewDoubaoSubmissionConfirmation,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoGenerationComplete,
  isDoubaoGenerationPending,
  isDoubaoCongestionReply,
  isDoubaoPromptRewritePage,
  isGenerationReadyForShare,
  isQuotaNotChargedFailure,
  promptSignature,
} from '../dist-electron/doubao-page-state.js'

test('detects Doubao infringement and violation failures', () => {
  const text = '生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。'
  const message = extractDoubaoFailureMessage(text)

  assert.equal(message, text)
  assert.equal(isQuotaNotChargedFailure(message), true)
})

test('detects common generation failure text', () => {
  assert.equal(extractDoubaoFailureMessage('视频生成失败，请稍后再试。'), '视频生成失败，请稍后再试。')
  assert.equal(extractDoubaoFailureMessage('你的视频免费额度还有 2 次。'), null)
})

test('keeps submitted or generating videos pending without hiding failures', () => {
  assert.equal(isDoubaoGenerationPending('正在为您生成一段 10 秒的视频，视频生成中，视频生成已提交'), true)
  assert.equal(isDoubaoGenerationPending('你的视频已经生成好了。'), false)
  assert.equal(
    isDoubaoGenerationPending('视频生成中，生成内容中疑似包含侵权 / 违规内容，无法返回该内容，生成额度未扣除。'),
    false
  )
})

test('extracts the new Doubao reply instead of returning the whole page', () => {
  const prompt = '生成一段 10 秒科普动画。\n画面比例：16:9。'
  const baseline = `豆包\n新对话\n${prompt}\n快速\n视频生成\n更多`
  const current = `${baseline}\n女性健康科普动画\nAI 生成可能有误 注意核实\n生成视频：${prompt}，10s\n这会儿有点热闹，我需要一点时间处理这个任务，别着急。`

  assert.equal(
    extractNewDoubaoReply(current, baseline, prompt),
    '这会儿有点热闹，我需要一点时间处理这个任务，别着急。'
  )
})

test('recognizes Doubao congestion replies', () => {
  assert.equal(isDoubaoCongestionReply('这会儿有点热闹，我需要一点时间处理这个任务，别着急。'), true)
  assert.equal(isDoubaoCongestionReply('当前请求较多，请稍后再试。'), true)
  assert.equal(isDoubaoCongestionReply('本次使用 Seedance 2.0 Mini 生成。'), false)
})

test('accepts both Doubao submission confirmation variants', () => {
  const baseline = '新对话 视频生成'
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 本次使用 Seedance 2.0 Mini 生成，视频生成好后会主动发送给你。`,
      baseline,
      'Seedance 2.0 Mini'
    ),
    true
  )
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 正在为您生成一段 10 秒的科普动画视频... 视频生成中 视频生成已提交`,
      baseline,
      'Seedance 2.0 Mini'
    ),
    true
  )
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 这会儿有点热闹，我需要一点时间处理这个任务。`,
      baseline,
      'Seedance 2.0 Mini'
    ),
    false
  )
})

test('detects the exhausted daily free generation quota message', () => {
  assert.equal(extractDoubaoFailureMessage('今日视频生成免费次数已用完。'), '今日视频生成免费次数已用完。')
  assert.equal(extractDoubaoFailureMessage('今日免费生成次数已用完，明天再来吧。'), '今日免费生成次数已用完，明天再来吧。')
  assert.equal(extractDoubaoFailureMessage('今日生成次数已用完。'), '今日生成次数已用完。')
  assert.equal(extractDoubaoFailureMessage('免费生成次数已用完，请明天再试。'), '免费生成次数已用完，请明天再试。')
  assert.equal(isQuotaNotChargedFailure('今日视频生成免费次数已用完'), false)
})

test('matches the current prompt by normalized signature', () => {
  const prompt = '生成视频：口播台词 “但如果经量突然明显增多，应该及时检查。”'
  const composerText = '生成视频 口播台词 但如果经量突然明显增多 应该及时检查'

  assert.equal(promptSignature(prompt).length > 10, true)
  assert.equal(containsPromptSignature(composerText, prompt), true)
  assert.equal(containsPromptSignature('搜索：其他历史对话', prompt), false)
})

test('identifies the requested Seedance model instead of inheriting Fast', () => {
  assert.equal(doubaoVideoModelLabel('mini'), 'Seedance 2.0 Mini')
  assert.equal(doubaoVideoModelFromText('Seedance 2.0 Mini'), 'mini')
  assert.equal(doubaoVideoModelFromText('Seedance 2.0 Fast'), 'fast')
  assert.equal(doubaoVideoModelFromText('Mini'), 'mini')
  assert.equal(doubaoVideoModelFromText('Fast'), 'fast')
  assert.equal(doubaoVideoModelFromText('Seedance 2.0 Mini Fast'), null)
})

test('accepts only new HTTP video links for the current generation', () => {
  assert.deepEqual(
    getNewDoubaoVideoUrls(
      ['https://cdn.example.com/old.mp4', 'https://cdn.example.com/current.mp4', 'blob:current'],
      ['https://cdn.example.com/old.mp4']
    ),
    ['https://cdn.example.com/current.mp4']
  )
  assert.deepEqual(
    getNewDoubaoVideoUrls(['https://www.doubao.com/thread/xbsMtOGRraAcehDc8'], []),
    []
  )
})

test('recognizes only newly added page messages', () => {
  const message = '生成内容中疑似包含侵权 / 违规内容，无法返回该内容，换个主题再试试，生成额度未扣除。'
  const baseline = `历史任务 ${message}`

  assert.equal(hasNewTextOccurrence(baseline, baseline, message), false)
  assert.equal(hasNewTextOccurrence(`${baseline} 新任务 ${message}`, baseline, message), true)
})

test('detects a newly submitted prompt in the conversation page', () => {
  const prompt = '生成一段 12 秒女性养生科普视频，画面比例 16:9。'
  const baseline = '历史对话 输入框'
  const current = `${baseline} 用户 ${prompt} 助手 本次使用 Seedance 2.0 Mini 生成`

  assert.equal(hasNewPromptOccurrence(current, baseline, prompt), true)
  assert.equal(hasNewPromptOccurrence(baseline, baseline, prompt), false)
})

test('extracts current Doubao share URL formats', () => {
  assert.equal(
    extractDoubaoShareUrl('复制链接：https://www.doubao.com/thread/abc_123?from=share。'),
    'https://www.doubao.com/thread/abc_123?from=share'
  )
  assert.equal(
    extractDoubaoShareUrl('https://doubao.com/chat/chat_123#video'),
    'https://doubao.com/chat/chat_123#video'
  )
  assert.equal(
    extractDoubaoShareUrl('https://www.doubao.com/share/share-123'),
    'https://www.doubao.com/share/share-123'
  )
  assert.equal(extractDoubaoShareUrl('https://example.com/thread/abc'), null)
})

test('accepts only chat pages as recoverable source conversations', () => {
  assert.equal(
    extractDoubaoConversationUrl('https://www.doubao.com/chat/local_2452181702532277'),
    'https://www.doubao.com/chat/local_2452181702532277'
  )
  assert.equal(
    extractDoubaoConversationUrl('https://www.doubao.com/chat/38437129678594562'),
    'https://www.doubao.com/chat/38437129678594562'
  )
  assert.equal(extractDoubaoConversationUrl('https://www.doubao.com/thread/xZR7KqTbeRvEAjlB8'), null)
})

test('does not treat prompt rewrite pages as generated videos', () => {
  assert.equal(
    isDoubaoPromptRewritePage('完整 12 秒视频生成指令（可直接用于视频生成工具）'),
    true
  )
  assert.equal(
    isDoubaoPromptRewritePage('你的视频生成好了，点击分享即可复制链接。'),
    false
  )
})

test('detects the Doubao desktop-download prompt that can block sharing', () => {
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 使用完整功能 随时帮忙的 AI 桌面助手 下载电脑版 下次提醒我'),
    true
  )
  assert.equal(
    isDoubaoDesktopDownloadPrompt('下载电脑版 使用完整功能 下载电脑版'),
    false
  )
})

test('recognizes the completion text shown by Doubao video cards', () => {
  assert.equal(isDoubaoGenerationComplete('你的视频生成好了。'), true)
  assert.equal(isDoubaoGenerationComplete('视频生成已提交，预计等待 5 分钟。'), false)
})

test('only treats a newly added completion message as the current result', () => {
  const oldMessages = '历史任务：你的视频生成好了。'
  const currentMessages = `${oldMessages} 新任务：你的视频生成好了。`

  assert.equal(hasNewGenerationCompletion(oldMessages, oldMessages), false)
  assert.equal(hasNewGenerationCompletion(currentMessages, oldMessages), true)
})

test('waits for a video element before treating the result as share-ready', () => {
  const base = {
    completionTextPresent: true,
    hasNewVideoSource: false,
    newVideoCount: 0,
    completionTextSeenAt: 1000,
    graceMs: 15000
  }
  // Text alone is not enough: still waiting for the video card.
  assert.equal(isGenerationReadyForShare({ ...base, now: 5000 }), false)
  // A new video source makes it ready immediately.
  assert.equal(isGenerationReadyForShare({ ...base, hasNewVideoSource: true, now: 2000 }), true)
  // A newly rendered video element also makes it ready.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCount: 1, now: 3000 }), true)
  // A playable blob/object URL video is also ready even without an HTTP source.
  assert.equal(isGenerationReadyForShare({ ...base, newPlayableVideoCount: 1, now: 3000 }), true)
  // The current Doubao build renders a video poster as an image before the
  // playable video element exists; the new card is sufficient to share.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCardCount: 1, now: 3000 }), true)
  // Stale videos from earlier tasks do not count.
  assert.equal(isGenerationReadyForShare({ ...base, newVideoCount: 0, now: 3000 }), false)
  // Completion text alone is never accepted as a share-ready result.
  assert.equal(isGenerationReadyForShare({ ...base, now: 17000 }), false)
  // No completion text means never ready, even with videos on the page.
  assert.equal(isGenerationReadyForShare({ ...base, completionTextPresent: false, newVideoCount: 1, now: 17000 }), false)
  // Completion text seen but grace not yet elapsed still waits.
  assert.equal(isGenerationReadyForShare({ ...base, completionTextSeenAt: 0, now: 17000 }), false)
})
