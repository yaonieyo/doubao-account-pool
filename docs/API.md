# 本地 API

## 基础信息

- 默认地址：`http://127.0.0.1:17888`
- 当前接口版本：`0.1.76`
- 默认认证：`Authorization: Bearer local-doubao-key`
- 除 `/health` 外，其余接口均需要 Bearer Token。
- 建议在“配置管理”中修改默认 API Key。

## 健康检查

```http
GET /health
```

## 查询账号

```http
GET /api/accounts
Authorization: Bearer <api-key>
```

账号记录增加 `quotaDate`（北京时间账期）、`nextQuotaResetAt`（下一次零点的 UTC ISO 时间）、`runningTaskCount`、`queuedTaskCount` 和 `maxConcurrentTasks`；原字段保持兼容。单个账号默认最多 3 条任务同时准备和发送，总任务并发上限默认 5，已有配置值不改写。

0.1.75 新增 `dailyQuotaExhausted`、`quotaExhaustedDate`、`quotaExhaustedReason` 和 `availableQuota`。豆包确认今日免费次数用完时，`availableQuota` 为 0，但 `quotaRemaining`、`quotaUsedToday` 仍保留真实本地账本，不伪造消费。退款、刷新、登录检测和重启不会清除当天标记；北京时间次日零点解除，不重置付费去水印次数。

0.1.76 的 Mini/Fast 本地单次消耗支持一位小数，最小仍为 1 点；余额、已用和任务扣点可能为小数。总每日额度仍为整数，原 API 字段及状态不变。每个任务保留预扣时的价格，换号和退款按该价格处理；可生成次数按每个账号可用点数向下取整，不能四舍五入成可生成任务。本地设置不是豆包官方计费承诺。

## 提交视频生成

```http
POST /api/generate
Authorization: Bearer <api-key>
Content-Type: multipart/form-data
```

也可以使用 JSON 提交；`aspectRatio` 和 `duration` 会保存到任务记录，并在豆包窗口发送前设置和校验。

```json
{
  "model": "seedance_2_0_mini",
  "aspectRatio": "9:16",
  "duration": 15,
  "prompt": "生成一段 5 秒视频"
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 视频提示词 |
| `model` | 否 | `seedance_2_0_mini` 或 `seedance_2_0_fast` |
| `accountId` | 否 | 正整数账号 ID；省略则自动调度；指定账号不可用或余额不足时返回 409，不会偷偷换用其他账号 |
| `aspectRatio` | 否 | `9:16` 或 `16:9`；省略时默认 `16:9`，保存到任务并在豆包窗口发送前校验 |
| `duration` | 否 | 视频时长（秒），`4` 到 `15` 的整数；省略时默认 `10`，保存到任务并在豆包窗口发送前通过「画幅/时长」设置弹窗选择和校验 |
| `referenceImage` | 否 | 上传的参考图片文件 |
| `referenceImagePath` | 否 | 本机参考图片绝对路径 |
| `referenceImageUrl` | 否 | 可下载的参考图片 URL |
| `callbackUrl` | 否 | 状态变化时接收 JSON 的回调地址 |
| `source` | 否 | 请求来源名称 |

生成请求固定执行最终 MP4 结果验证。去水印失败、平台不支持或没有取得可播放 MP4 时，任务状态为 `failed`。

有足够额度但达到并发上限时，请求仍可返回 `accepted` 并预扣额度进入队列。每条任务的准备、发送和受理等待独立进行，不因同账号前一条尚未受理而串行阻塞。若豆包明确限制并发，保留原文并等待已有任务结束，不绕过限制或无限催发。

每天北京时间 00:00 自动切换本地每日账期；启动、唤醒和接收请求时补检查，同一天不重复补额。正式受理的任务保留原账期，未受理的排队任务进入新账期重新预扣；余额不足继续排队，不超扣。升级时未知账期初始化为升级当天并保留当前余额，不擅自补满。此机制不修改豆包服务端额度，也不重置第三方付费去水印次数。

自动分配的任务收到明确的每日次数耗尽拒绝、尚未正式受理时，可在同一个 `requestId` 下换号继续。回调先显示换号排队信息，不会先发 `failed` 再恢复运行；提示词、参考图、模型、画幅和回调地址不变，调用方无需重新提交。已发送但结果未明的任务不会因另一条任务的拒绝而换号；已正式受理的任务继续在原对话取结果。无其他可用账号或任务明确指定 `accountId` 时，直接失败并只退回尚持有的预扣。

这类失败统一返回下列结构，不能与去水印服务的 `watermark / quota_exhausted` 混淆：

```json
{
  "stage": "account",
  "code": "doubao_daily_quota_exhausted",
  "title": "豆包今日免费次数已用完",
  "detail": "今日视频生成免费次数用完了，你明天再来找我继续吧。",
  "retryable": false
}
```

分配版本在内部用于隔离旧执行的迟到更新、退款和回调，不改变公开状态枚举、成功结果或画布接入地址。

## 无限画布接入约定

推荐由无限画布或 AI/Codex 等能够调用本机 HTTP API 的客户端接入本服务。客户端只负责提交提示词、参考图和任务参数，并保存 `requestId`；不要直接操作豆包窗口、系统剪贴板或账号 Cookie。

- 同一台电脑上的画布使用 `http://127.0.0.1:17888`；远程画布应通过受保护的 HTTPS 代理或隧道访问，不要把本地端口无认证暴露到公网。
- 有回调服务时传入 `callbackUrl`；没有回调服务时按 3 到 5 秒轮询 `GET /api/requests/:requestId`。
- 画布必须按 `requestId` 更新原任务，即使多个任务的账号、标题或提示词相同，也不能合并判断。
- `cleanVideoUrl` 只能是经过验证的可播放 MP4 地址；`outputVideoPath` 只能是已经存在的本地 `.mp4` 文件。
- `doubao.com/chat/...`、`doubao.com/thread/...` 和分享页地址只用于账号池内部恢复、复制和去水印解析，不能写入 `cleanVideoUrl`。
- 本地账号分区、Cookie、SQLite、参考图、输出视频和 Token 不属于接口参数，也不会随 Git 发布。

## 查询任务状态

```http
GET /api/requests/:requestId
Authorization: Bearer <api-key>
```

状态：

| 状态 | 说明 |
| --- | --- |
| `accepted` | 已接收并进入队列，或异常退出后暂停、等待恢复已有结果 |
| `running` | 正在操作豆包或等待生成 |
| `success` | 已取得经过验证的 MP4 地址或本地 MP4 文件 |
| `failed` | 提交、生成、解析或 MP4 验证失败 |
| `stopped` | 任务已停止 |

## 终止任务并退回本地额度

```http
POST /api/requests/:requestId/stop
Authorization: Bearer <api-key>
```

仅允许终止 `accepted` 或 `running` 任务。程序会从本地队列移除任务或关闭对应执行窗口，只释放该任务的执行名额；同账号仍有任务时不会显示为空闲。按任务记录的实际扣点只退款一次；响应中的 `quotaRefunded` 表示额度是否已退回。旧账期任务退款只修改原预扣记录，不增加今天的余额。若请求已经提交到豆包，该接口不会撤回豆包平台正在进行的生成。

## 恢复历史结果

```http
POST /api/requests/:requestId/retry-result
Authorization: Bearer <api-key>
```

该接口只重新查找并解析历史生成结果，不会再次提交视频生成，也不会重复扣除额度。

正在执行或排队的任务不能重复恢复。已记录准确源对话的任务固定在自己的对话中找结果，不按重复标题或相同提示词取其他任务的视频；源对话和内部分享地址分别保存，公开成功结果仍只包含已验证的 MP4。

## 单独解析视频结果

保存去水印地址或 Token 后，后续解析尝试读取最新配置，包括已经处于生成等待中的任务、结果恢复和独立解析，无需重启本地服务。已经发出的上游请求不会被撤回；有效 MP4 成功结果不因换配置而重复解析。失败时若发现配置已更新，在有限重试内切换；上限用完则返回 `watermark / configuration_changed`，可恢复已有结果，不重新生成视频。已结束的失败任务不会因保存配置而自动重跑。此机制不改变去水印协议，不代表任意第三方接口都兼容。

### 查询最近的去水印用量

```http
GET /api/watermark/status
Authorization: Bearer <api-key>
```

只读取本机缓存，不额外调用解析服务。`usage` 来自当前接口/Token 最近一次解析响应的 `data.usage`；没有数据时为 `null`。`usageUpdatedAt` 是余额同步时间，`checkedAt` 是最近一次解析检查时间，两者可能不同。更换 Token 后不沿用其它 Token 的余额。

```json
{
  "configured": true,
  "usage": { "totalLimit": 1000, "usedCount": 532, "remainingCount": 468 },
  "usageUpdatedAt": "2026-10-19T09:00:00.000Z",
  "checkedAt": "2026-10-19T09:00:00.000Z",
  "error": null
}
```

### 解析已有分享地址

```http
POST /api/watermark/parse
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "url": "<supported-source-url>"
}
```

成功时返回经过验证的 `cleanVideoUrl`；失败时返回 HTTP 422 和 `status: "failed"`。

去水印服务存在短暂的资源准备延迟。程序会先验证返回地址确实是可播放 MP4，未就绪时使用短间隔重试；重试状态会按任务顺序异步通知回调，不会阻塞视频结果解析。

## 失败原因

任务查询、回调和独立解析失败响应增加 `error`，原有 `status`、`message` 和视频字段保持兼容：

```json
{
  "status": "failed",
  "message": "去水印次数已耗尽",
  "error": {
    "stage": "watermark",
    "code": "quota_exhausted",
    "title": "去水印次数已耗尽",
    "detail": "API Token调用次数已耗尽",
    "suggestion": "补充去水印次数后恢复结果，无需重新生成视频。",
    "retryable": false
  },
  "cleanVideoUrl": null
}
```

`stage` 包括 `account`、`submission`、`generation`、`sharing`、`watermark`、`output` 和 `unknown`。去水印分类包括 `quota_exhausted`、`token_missing`、`token_invalid`、`token_disabled`、`access_denied`、`rate_limited`、`resource_pending`、`network_error`、`unsupported_platform` 和 `invalid_video`。仅明确返回次数不足时才使用 `quota_exhausted`；不明确的 HTTP 403 使用 `access_denied`。

`retryable` 表示当前故障是否适合自动短暂重试，不表示视频要重新生成。已有视频的去水印次数不足时，应先补充额度，再调用原任务的 `retry-result`。

## 成功语义

外部接口不会把豆包分享页、聊天页或 thread 页面地址当作视频结果。只有满足以下任一条件才返回 `status: "success"`：

- `cleanVideoUrl` 是经过验证、可访问的 MP4 视频地址。
- `outputVideoPath` 是已经保存成功的本地 `.mp4` 文件路径。
