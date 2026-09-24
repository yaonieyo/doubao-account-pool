import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsPromptSignature,
  doubaoAspectRatioFromText,
  isDoubaoAspectRatioTriggerText,
  doubaoVideoModelFromText,
  doubaoVideoModelLabel,
  isDoubaoVideoModelTriggerText,
  extractDoubaoConversationUrl,
  extractDoubaoFailureMessage,
  extractNewDoubaoReply,
  extractDoubaoShareUrl,
  extractDoubaoWatermarkShareUrl,
  getNewDoubaoVideoUrls,
  hasStrongSubmissionEvidence,
  hasNewDoubaoSubmissionConfirmation,
  hasNewGenerationCompletion,
  hasNewPromptOccurrence,
  hasNewTextOccurrence,
  isDoubaoDesktopDownloadPrompt,
  isDoubaoGenerationActionText,
  isDoubaoSafetyConfirmationDialog,
  isDoubaoGenerationComplete,
  isDoubaoGenerationPending,
  isDoubaoCongestionReply,
  isDoubaoPromptSuggestion,
  isDoubaoPromptRewritePage,
  isGenerationReadyForShare,
  isFormalDoubaoConversationUrl,
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
  assert.equal(isDoubaoGenerationPending('已提交生成任务，等待渲染完成。视频生成需要多长时间？可以添加一些舒缓的背景音乐吗？'), true)
  assert.equal(isDoubaoGenerationPending('正在渲染，请稍候。'), true)
  assert.equal(
    isDoubaoGenerationPending('本次使用 **Seedance 2.0 Mini** 生成，预计等待 5 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。'),
    true
  )
  assert.equal(
    isDoubaoGenerationComplete('本次使用 Seedance 2.0 Mini 生成，视频生成好后会主动发送给你。'),
    false
  )
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

test('ignores Doubao shell and download prompt text as a reply', () => {
  const prompt = '生成一段 10 秒科普动画视频。'
  const baseline = '豆包\n新对话\n快速\n视频生成'
  const current = `${baseline}\n${prompt}\n今天 14:44 下载电脑客户端 创作高质量视觉素材 立即下载 对话 豆包 快速`

  assert.equal(extractNewDoubaoReply(current, baseline, prompt), null)
})

test('ignores the timestamped conversation header as a reply', () => {
  const prompt = '生成一段 10 秒科普动画视频。'
  const baseline = '豆包\n新对话\n快速\n视频生成'
  const current = `${baseline}\n${prompt}\n今天 15:34 对话 豆包 快速`

  assert.equal(extractNewDoubaoReply(current, baseline, prompt), null)
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
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 已提交视频生成任务，请耐心等待。`,
      baseline,
      'Seedance 2.0 Mini'
    ),
      true
  )
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 已提交生成任务，等待渲染完成。视频生成需要多长时间？`,
      baseline,
      'Seedance 2.0 Mini'
    ),
    true
  )
  assert.equal(
    hasNewDoubaoSubmissionConfirmation(
      `${baseline} 本次使用 **Seedance 2.0 Mini** 生成，预计等待 5 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。`,
      baseline,
      'Seedance 2.0 Mini'
    ),
    true
  )
})

test('recognizes Doubao confirmation and direct-generation actions', () => {
  assert.equal(isDoubaoGenerationActionText('确认生成 →'), true)
  assert.equal(isDoubaoGenerationActionText('直接生成'), true)
  assert.equal(isDoubaoGenerationActionText('使用此提示词生成'), true)
  assert.equal(isDoubaoGenerationActionText('视频生成'), false)
})

test('recognizes only the material authorization safety confirmation dialog', () => {
  assert.equal(
    isDoubaoSafetyConfirmationDialog('安全确认 你在本功能中上传、使用的素材，均已获充分授权，无侵权违法风险。 拒绝 确认'),
    true
  )
  assert.equal(isDoubaoSafetyConfirmationDialog('确认生成'), false)
  assert.equal(isDoubaoSafetyConfirmationDialog('安全确认 拒绝'), false)
})

test('recognizes prompt suggestions as non-terminal replies', () => {
  assert.equal(isDoubaoPromptSuggestion('生成建议：可以直接生成这段视频。'), true)
  assert.equal(isDoubaoPromptSuggestion('可以直接生成这段视频。'), true)
  assert.equal(isDoubaoPromptSuggestion('确认后我再开始生成视频。'), true)
  assert.equal(isDoubaoPromptSuggestion('确认后开始生成视频。'), true)
  assert.equal(
    isDoubaoPromptSuggestion('模型：Seedance 2.0 Mini 时长：10 秒 比例：9:16 竖屏 素材：参考原图 画面推进：人物渐显 画幅：9:16 竖屏 风格：真实生活纪实感 整体氛围：温和共情 0-3s（镜头 1）画面：夜晚居家办公场景 声音：中文女声 文字：无'),
    true
  )
  assert.equal(isDoubaoPromptSuggestion('要不要我再给你一版精简版提示词？'), true)
  assert.equal(isDoubaoPromptSuggestion('画面完整提示词：总时长 10s，镜头与动效如下。'), true)
  assert.equal(
    isDoubaoPromptSuggestion('二、配音文案（严格匹配 10s 时长） 三、AI 生成优化提示词（可直接复制使用） 16:9 aspect ratio'),
    true
  )
  assert.equal(
    isDoubaoPromptSuggestion('表格 时长 画面内容 运镜 & 光影 口播同步，整体基调如下。'),
    true
  )
  assert.equal(isDoubaoPromptSuggestion('需要我帮你把这个片段和前面片段合并成完整连贯的脚本吗？'), true)
  assert.equal(isDoubaoPromptSuggestion('需要我帮你把这一段合并进完整的分镜脚本吗？'), true)
  assert.equal(isDoubaoPromptSuggestion('视频中女性的穿着有什么要求？视频中可以添加音乐吗？视频的拍摄角度有哪些建议？'), true)
  assert.equal(isDoubaoPromptSuggestion('7-10s（收尾）画面：双人物画面保留，柔和自然光不变，卡片保持在画面底部，整体画面干净留白充足，人物主体清晰，动作自然，色调保持统一。无大段广告文案，不制造焦虑。'), true)
  assert.equal(isDoubaoPromptSuggestion('故事段 02｜10 秒竖屏视频生成提示词（9:16）情绪：从安静静坐过渡到肩颈紧绷，动作缓慢克制，无夸张表演。'), true)
  assert.equal(isDoubaoPromptSuggestion('分节拍连续动作 0‑3 秒（节拍 1）：女性安静坐在工位，身体放松。3‑7 秒（节拍 2）：肩膀微微耸起，音频仅保留室内环境声。'), true)
  assert.equal(isDoubaoPromptSuggestion('负面提示词：文字错乱，水印 logo。需要我继续生成片段 2 的提示词吗？'), true)
  assert.equal(isDoubaoPromptSuggestion('AI 生成提示词（可直接复制给 AI 视频工具）竖屏 9:16，10 秒。'), true)
  assert.equal(isDoubaoPromptSuggestion('如果你需要，我可以继续帮你写片段 2、片段 3 的完整视频提示词。'), true)
  assert.equal(isDoubaoPromptSuggestion('生成内容中疑似包含侵权 / 违规内容，额度未扣除。'), false)
  assert.equal(isDoubaoPromptSuggestion('我暂时无法生成你要求的内容。请尝试输入其他要求。'), false)
  assert.equal(isDoubaoPromptSuggestion('正在为您生成一段 10 秒视频，视频生成中。'), false)
})

test('matches submission confirmation when Doubao splits it across lines', () => {
  const baseline = '新对话\n视频生成'
  const current = `${baseline}\n本次使用\nSeedance 2.0 Mini\n生成，视频生成好后会主动发送给你。`

  assert.equal(
    hasNewDoubaoSubmissionConfirmation(current, baseline, 'Seedance 2.0 Mini'),
    true
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
  assert.equal(isDoubaoVideoModelTriggerText('模型 Seedance 2.0 Mini'), true)
  assert.equal(isDoubaoVideoModelTriggerText('Seedance 2.0 Fast'), true)
  assert.equal(isDoubaoVideoModelTriggerText('本次使用 Seedance 2.0 Mini 生成'), false)
})

test('recognizes an explicit Doubao aspect ratio without guessing when both are present', () => {
  assert.equal(doubaoAspectRatioFromText('画面比例：9:16'), '9:16')
  assert.equal(doubaoAspectRatioFromText('视频画幅 16:9'), '16:9')
  assert.equal(doubaoAspectRatioFromText('可选：9:16 或 16:9'), null)
  assert.equal(doubaoAspectRatioFromText('没有画幅设置'), null)
  assert.equal(isDoubaoAspectRatioTriggerText('自动 · 10s'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('9:16 · 10s'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('16:9 · 10s'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('16:9'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('画面比例：16:9'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('比例 16:9 · 10 秒'), true)
  assert.equal(isDoubaoAspectRatioTriggerText('提示词要求画面比例 16:9，人物居中'), false)
  assert.equal(isDoubaoAspectRatioTriggerText('视频生成'), false)
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
  assert.equal(
    hasNewTextOccurrence(
      `${baseline}\n新任务\n生成内容中疑似包含侵权 / 违规内容，\n无法返回该内容，换个主题再试试，\n生成额度未扣除。`,
      baseline,
      message
    ),
    true
  )
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

test('only accepts thread or share URLs for watermark providers', () => {
  assert.equal(
    extractDoubaoWatermarkShareUrl('https://www.doubao.com/thread/abc_123?from=share。'),
    'https://www.doubao.com/thread/abc_123?from=share'
  )
  assert.equal(
    extractDoubaoWatermarkShareUrl('https://www.doubao.com/share/share-123'),
    'https://www.doubao.com/share/share-123'
  )
  assert.equal(extractDoubaoWatermarkShareUrl('https://doubao.com/chat/chat_123#video'), null)
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

test('distinguishes formal conversations from unsent local drafts', () => {
  assert.equal(isFormalDoubaoConversationUrl('https://www.doubao.com/chat/local_2452181702532277'), false)
  assert.equal(isFormalDoubaoConversationUrl('https://www.doubao.com/chat/38437129678594562'), true)
  assert.equal(isFormalDoubaoConversationUrl('https://www.doubao.com/thread/xZR7KqTbeRvEAjlB8'), false)
})

test('does not accept a cleared composer or unrelated page change as submission', () => {
  assert.equal(hasStrongSubmissionEvidence({
    confirmationTextAdded: false,
    promptMessageAdded: false,
    formalConversationUrl: false,
    composerCleared: true,
    pageChanged: true,
  }), false)
  assert.equal(hasStrongSubmissionEvidence({
    confirmationTextAdded: false,
    promptMessageAdded: true,
    formalConversationUrl: false,
    composerCleared: true,
    pageChanged: true,
  }), false)
  assert.equal(hasStrongSubmissionEvidence({
    confirmationTextAdded: false,
    promptMessageAdded: true,
    formalConversationUrl: true,
    composerCleared: true,
    pageChanged: true,
  }), true)
  assert.equal(hasStrongSubmissionEvidence({
    confirmationTextAdded: true,
    promptMessageAdded: false,
    formalConversationUrl: false,
    composerCleared: false,
    pageChanged: false,
  }), true)
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
