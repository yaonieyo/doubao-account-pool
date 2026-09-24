export function normalizeComparableText(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

export type DoubaoVideoModelName = "mini" | "fast";

export function doubaoVideoModelLabel(model: DoubaoVideoModelName) {
  return model === "mini" ? "Seedance 2.0 Mini" : "Seedance 2.0 Fast";
}

export function doubaoVideoModelFromText(value: string | null | undefined): DoubaoVideoModelName | null {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const compact = text.replace(/[^a-z0-9]+/g, "");
  const hasMini = compact.includes("seedance20mini") || /(?:^|\s)mini(?:\s|$)/.test(text);
  const hasFast = compact.includes("seedance20fast") || /(?:^|\s)fast(?:\s|$)/.test(text);
  if (hasMini === hasFast) return null;
  return hasMini ? "mini" : "fast";
}

export function isDoubaoVideoModelTriggerText(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return /^(?:模型\s*)?Seedance\s*2\.0\s*(?:Mini|Fast)$/i.test(text);
}

export function doubaoAspectRatioFromText(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, "");
  const has916 = /9:16/.test(text);
  const has169 = /16:9/.test(text);
  if (has916 === has169) return null;
  return has916 ? "9:16" : "16:9";
}

export function isDoubaoAspectRatioTriggerText(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 48) return false;
  return /^(?:(?:画面)?(?:比例|画幅)\s*[:：]?\s*)?(?:自动|9:16|16:9|3:4|4:3|1:1|21:9)(?:\s*(?:[·•|,/]|-|—)?\s*\d+(?:\.\d+)?\s*(?:s|秒))?$/i.test(text);
}

const DOUBAO_SHARE_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/(?:thread|chat|share)\/[A-Za-z0-9._~-]+(?:[\/?#][^\s"'<>]*)?/i;
const DOUBAO_WATERMARK_SHARE_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/(?:thread|share)\/[A-Za-z0-9._~-]+(?:[\/?#][^\s"'<>]*)?/i;
const DOUBAO_CONVERSATION_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/chat\/[A-Za-z0-9._~-]+(?:[\/?#][^\s"'<>]*)?/i;

export function extractDoubaoShareUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_SHARE_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

export function extractDoubaoWatermarkShareUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_WATERMARK_SHARE_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

export function extractDoubaoConversationUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_CONVERSATION_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

export function isFormalDoubaoConversationUrl(value: string | null | undefined) {
  try {
    const url = new URL(String(value || ""));
    if (!/^(?:www\.)?doubao\.com$/i.test(url.hostname)) return false;
    const matched = url.pathname.match(/^\/chat\/([A-Za-z0-9._~-]+)(?:\/|$)/i);
    const conversationId = matched?.[1] || "";
    return Boolean(conversationId) && !conversationId.toLowerCase().startsWith("local_");
  } catch {
    return false;
  }
}

export interface SubmissionEvidenceInput {
  confirmationTextAdded: boolean;
  promptMessageAdded: boolean;
  formalConversationUrl: boolean;
  composerCleared: boolean;
  pageChanged: boolean;
}

/** Clearing the composer or observing unrelated page mutations never proves a send. */
export function hasStrongSubmissionEvidence(input: SubmissionEvidenceInput) {
  return input.confirmationTextAdded
    || (input.promptMessageAdded && input.formalConversationUrl);
}

export function promptSignature(prompt: string) {
  const normalized = normalizeComparableText(prompt);
  return normalized.slice(0, Math.min(42, Math.max(12, normalized.length)));
}

export function containsPromptSignature(value: string, prompt: string) {
  const signature = promptSignature(prompt);
  return signature.length > 0 && normalizeComparableText(value).includes(signature);
}

export function isDoubaoPromptRewritePage(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  return /完整\s*\d+(?:\.\d+)?\s*秒视频生成指令|可直接用于(?:AI\s*)?视频生成工具|要不要我再精简一版提示词/.test(text);
}

export function isDoubaoGenerationActionText(value: string | null | undefined) {
  const text = String(value || "").replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const labels = [
    "确认生成",
    "直接生成",
    "使用此提示词生成",
    "用此提示词生成",
    "开始生成",
    "继续生成"
  ];
  return labels.some((label) => text === label || text.startsWith(label));
}

export function isDoubaoSafetyConfirmationDialog(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, "").trim();
  return text.includes("安全确认")
    && text.includes("上传、使用的素材")
    && text.includes("已获充分授权")
    && text.includes("拒绝")
    && text.includes("确认");
}

export function isDoubaoPromptSuggestion(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || extractDoubaoFailureMessage(text) || isDoubaoGenerationComplete(text) || isDoubaoGenerationPending(text)) {
    return false;
  }
  const directMarkers = [
    "可以直接生成",
    "确认后我再开始生成视频",
    "确认后开始生成视频",
    "确认后我会开始生成",
    "确认后再开始生成",
    "确认即可生成",
    "请确认后生成",
    "生成建议",
    "可直接用于视频生成工具",
    "可直接用于AI视频生成工具",
    "直接复制就能导入",
    "直接粘贴给视频生成工具",
    "可直接复制给",
    "可直接复制使用",
    "精简版提示词",
    "完整提示词",
    "完整视频提示词",
    "纯提示词",
    "画面提示词",
    "画面完整提示词",
    "负面限制",
    "负面提示词",
    "AI 生成提示词",
    "AI生成提示词",
    "分镜脚本",
    "完整连贯的脚本",
    "时长区间",
    "镜头与动效",
    "要不要我",
    "需要我再",
    "需要我帮你",
    "需要我继续",
    "如果你需要",
    "我可以继续帮你"
  ];
  if (directMarkers.some((marker) => text.includes(marker))) return true;

  // Some accounts answer with a short list of video-specific questions
  // instead of using the structured suggestion wording above.
  if (/(?:视频|画面|提示词|比例|时长|音乐|穿着|拍摄角度)[^。！？]*[?？]/.test(text)
    && /(?:可以|需要|要求|建议|是否|要不要|吗)/.test(text)) {
    return true;
  }

  if (text.length >= 80
    && /(?:画面|镜头|人物|场景|卡片|收尾|开头|中段)/.test(text)
    && /(?:视频|生成|\d+\s*[秒s]|时长|画幅|配色|主体|分镜)/.test(text)) {
    return true;
  }

  if (/(?:故事段|视频生成提示词|视频生成指令|分节拍|节拍)/.test(text)
    && /(?:\d+\s*[秒s]|竖屏|横屏|9:16|16:9)/i.test(text)) {
    return true;
  }

  if (/(?:\d+\s*[-‑–—~至]\s*\d+\s*[秒s])/i.test(text)
    && /(?:画面|动作|音频|声音|旁白|镜头|场景|人物|节拍|配音|文字)/.test(text)) {
    return true;
  }

  const structuredReplyMarkers = [
    "模型",
    "比例",
    "素材",
    "画面推进",
    "画幅",
    "风格",
    "整体氛围",
    "整体基调",
    "画面",
    "声音",
    "文字",
    "总时长",
    "时长",
    "画面内容",
    "配音文案",
    "口播",
    "旁白",
    "运镜",
    "光影",
    "镜头",
    "生成优化提示词",
    "提示词"
  ];
  return structuredReplyMarkers.filter((marker) => text.includes(marker)).length >= 3;
}

export function isDoubaoDesktopDownloadPrompt(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  return text.includes("下载电脑版")
    && text.includes("使用完整功能")
    && text.includes("下次提醒我");
}

export function isDoubaoGenerationComplete(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  return /你的视频(?:已经|已)?生成好[了啦]|视频(?:已经|已)?生成(?:完成|成功|好[了啦])|生成视频(?:已经|已)?完成/.test(text);
}

export function isDoubaoGenerationPending(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").replace(/\*+/g, "").trim();
  if (!text || extractDoubaoFailureMessage(text) || isDoubaoGenerationComplete(text)) return false;
  // Doubao may append follow-up questions to an accepted task. These status
  // phrases are stronger evidence than the question-shaped tail of a reply.
  if (/正在为您生成一段|视频生成中|视频生成已提交|已提交视频生成任务|已提交生成任务|生成任务已提交|正在渲染|等待(?:视频)?(?:生成|渲染)(?:完成|结果)/.test(text)) {
    return true;
  }

  // The normal Mini/Fast confirmation says the task is accepted and will be
  // delivered later; it does not always include "视频生成中".
  return /本次使用\s+Seedance\s+2\.0\s+(?:Mini|Fast)\s+生成/.test(text)
    && (/预计等待\s*\d+\s*分钟|视频生成好后|本次生成将消耗每日免费额度/.test(text));
}

const GENERATION_COMPLETE_PATTERNS = [
  /你的视频(?:已经|已)?生成好[了啦]/g,
  /视频(?:已经|已)?生成(?:完成|成功|好[了啦])/g,
  /生成视频(?:已经|已)?完成/g
];

export function hasNewGenerationCompletion(currentText: string, baselineText: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const countMatches = (value: string, pattern: RegExp) => value.match(new RegExp(pattern.source, "g"))?.length || 0;
  const current = normalize(currentText);
  const baseline = normalize(baselineText);
  return GENERATION_COMPLETE_PATTERNS.some((pattern) => countMatches(current, pattern) > countMatches(baseline, pattern));
}

export function getNewDoubaoVideoUrls(currentUrls: string[], baselineUrls: string[]) {
  const baseline = new Set(baselineUrls);
  return Array.from(new Set(currentUrls.filter((url) => {
    if (!/^https?:\/\//i.test(url) || baseline.has(url)) return false;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname !== "doubao.com" && hostname !== "www.doubao.com";
    } catch {
      return false;
    }
  })));
}

export interface GenerationReadyInput {
  completionTextPresent: boolean;
  hasNewVideoSource: boolean;
  newVideoCount: number;
  newPlayableVideoCount?: number;
  newVideoCardCount?: number;
  completionTextSeenAt: number;
  now: number;
  graceMs?: number;
}

/**
 * Decides whether a finished Doubao video is safe to share. Doubao renders the
 * "视频生成好了" text before the finished video card appears; copying the share
 * link in that window yields a thread URL without the video. A completion
 * message alone is never sufficient: the current task must have a new card.
 */
export function isGenerationReadyForShare(input: GenerationReadyInput) {
  if (!input.completionTextPresent) return false;
  const videoReady = input.hasNewVideoSource
    || input.newVideoCount > 0
    || (input.newPlayableVideoCount || 0) > 0
    || (input.newVideoCardCount || 0) > 0;
  return videoReady;
}

export function extractDoubaoFailureMessage(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const failurePatterns = [
    /生成内容中疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /(?:侵权|违规)内容[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /无法返回该内容[^。！？]*(?:[。！？]|$)/,
    /换个主题再试试[^。！？]*(?:[。！？]|$)/,
    /生成额度未扣除[^。！？]*(?:[。！？]|$)/,
    /额度未扣除[^。！？]*(?:[。！？]|$)/,
    /今日(?:的)?(?:视频)?(?:生成)?(?:免费)?(?:生成)?次数(?:已|已经)?用完[^。！？]*(?:[。！？]|$)/,
    /免费(?:生成)?次数(?:已|已经)?用完[^。！？]*(?:[。！？]|$)/,
    /视频生成失败[^。！？]*(?:[。！？]|$)/,
    /生成视频失败[^。！？]*(?:[。！？]|$)/,
    /未能生成视频[^。！？]*(?:[。！？]|$)/
  ];

  for (const pattern of failurePatterns) {
    const matched = text.match(pattern)?.[0]?.trim();
    if (matched) return matched;
  }

  return null;
}

export function extractNewDoubaoReply(currentText: string, baselineText: string, prompt: string) {
  const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const replyNoise = new Set([
    "AI 生成可能有误 注意核实",
    "快速",
    "视频生成",
    "图像生成",
    "帮我写作",
    "PPT 生成",
    "翻译",
    "深入研究",
    "录音转写",
    "记录会议",
    "音乐生成",
    "更多",
    "对话",
    "AI 播客",
    "豆包",
    "下载电脑客户端",
    "使用完整功能",
    "创作高质量视觉素材",
    "立即下载",
    "下次提醒我"
  ]);
  const pageChromeMarkers = [
    "下载电脑客户端",
    "使用完整功能",
    "创作高质量视觉素材",
    "立即下载",
    "下次提醒我"
  ];
  const generationStatusPattern = /^(?:本次使用|正在为您生成一段|视频生成中|视频生成已提交|已提交视频生成任务|预计等待|视频生成好后|本次生成将消耗每日免费额度)/;
  const lines = (value: string) => value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const baselineCounts = new Map<string, number>();
  for (const line of lines(baselineText)) {
    baselineCounts.set(line, (baselineCounts.get(line) || 0) + 1);
  }

  const promptLines = new Set(lines(prompt));
  const promptFragments = Array.from(promptLines)
    .map(normalize)
    .filter((fragment) => fragment.length >= 6);
  const normalizedPrompt = normalize(prompt);
  const signature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
  const currentLines = lines(currentText);
  const disclaimerIndex = currentLines.lastIndexOf("AI 生成可能有误 注意核实");
  const scopedLines = disclaimerIndex >= 0 ? currentLines.slice(disclaimerIndex + 1) : currentLines;
  const additions: string[] = [];
  for (const line of scopedLines) {
    const remaining = baselineCounts.get(line) || 0;
    if (remaining > 0) {
      baselineCounts.set(line, remaining - 1);
      continue;
    }
    if (promptLines.has(line) || replyNoise.has(line)) continue;
    if (pageChromeMarkers.some((marker) => line.includes(marker))) continue;
    if (generationStatusPattern.test(line)) continue;
    if (/^(?:今天|昨天|前天|\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:对话|AI 播客|豆包|快速)/.test(line)) continue;
    const normalizedLine = normalize(line);
    if (signature && normalizedLine.includes(signature)) continue;
    if (promptFragments.some((fragment) => normalizedLine.includes(fragment))) continue;
    if (/^(搜索|新对话|新工作任务|AI 创作|云盘|技能|项目|创建新项目|最近|主对话|下载电脑版)$/.test(line)) continue;
    if (line.length < 2) continue;
    additions.push(line);
  }

  if (!additions.length) return null;
  return additions.slice(-6).join(" ").slice(0, 600);
}

export function isDoubaoCongestionReply(value: string | null | undefined) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return /这会儿有点热闹|需要一点时间处理这个任务|当前请求较多|服务繁忙|系统繁忙|稍后再试/.test(text);
}

export function hasNewDoubaoSubmissionConfirmation(
  currentText: string,
  baselineText: string,
  modelLabel: string
) {
  const normalizeForMatch = (value: string) => value.replace(/\s+/g, "");
  const countOccurrences = (text: string, needle: string) => {
    let count = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(needle, index);
      if (index === -1) return count;
      count += 1;
      index += needle.length;
    }
  };
  const confirmations = [
    `本次使用 ${modelLabel} 生成`,
    "正在为您生成一段",
    "视频生成中",
    "视频生成已提交",
    "已提交视频生成任务",
    "已提交生成任务",
    "生成任务已提交",
    "正在渲染",
    "等待渲染完成",
    "等待视频生成完成",
    "预计等待",
    "视频生成好后",
    "本次生成将消耗每日免费额度"
  ];
  const current = normalizeForMatch(currentText);
  const baseline = normalizeForMatch(baselineText);
  return confirmations.some((confirmation) => (
    countOccurrences(current, normalizeForMatch(confirmation))
      > countOccurrences(baseline, normalizeForMatch(confirmation))
  ));
}

export function countTextOccurrences(text: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

export function hasNewTextOccurrence(currentText: string, baselineText: string, needle: string) {
  const normalizeForMatch = (value: string) => value.replace(/\s+/g, "");
  const count = (text: string) => {
    if (!needle) return 0;
    const normalizedText = normalizeForMatch(text);
    const normalizedNeedle = normalizeForMatch(needle);
    if (!normalizedNeedle) return 0;
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = normalizedText.indexOf(normalizedNeedle, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += normalizedNeedle.length;
    }
  };
  return count(currentText) > count(baselineText);
}

export function hasNewPromptOccurrence(currentText: string, baselineText: string, prompt: string) {
  const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
  const normalizedPrompt = normalize(prompt);
  const signature = normalizedPrompt.slice(0, Math.min(42, Math.max(12, normalizedPrompt.length)));
  if (!signature) return false;

  const count = (text: string) => {
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(signature, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += signature.length;
    }
  };

  return count(normalize(currentText)) > count(normalize(baselineText));
}

export function isQuotaNotChargedFailure(message: string) {
  return /额度未扣除|生成额度未扣除|未消耗|未扣费|不会扣除/.test(message);
}
