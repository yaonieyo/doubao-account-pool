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

const DOUBAO_SHARE_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/(?:thread|chat|share)\/[A-Za-z0-9._~-]+(?:[\/?#][^\s"'<>]*)?/i;
const DOUBAO_CONVERSATION_URL_RE = /https?:\/\/(?:www\.)?doubao\.com\/chat\/[A-Za-z0-9._~-]+(?:[\/?#][^\s"'<>]*)?/i;

export function extractDoubaoShareUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_SHARE_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
}

export function extractDoubaoConversationUrl(value: string | null | undefined) {
  if (!value) return null;
  const matched = value.match(DOUBAO_CONVERSATION_URL_RE)?.[0];
  return matched?.replace(/[)\]}>，。！？；;]+$/, "") || null;
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
  const count = (text: string) => {
    if (!needle) return 0;
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(needle, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += needle.length;
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
