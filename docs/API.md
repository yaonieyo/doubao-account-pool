# 本地 API

## 基础信息

- 默认地址：`http://127.0.0.1:17888`
- 当前接口版本：`0.1.72`
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

## 提交视频生成

```http
POST /api/generate
Authorization: Bearer <api-key>
Content-Type: multipart/form-data
```

也可以使用 JSON 提交；`aspectRatio` 会保存到任务记录，并在豆包窗口发送前设置和校验。

```json
{
  "model": "seedance_2_0_mini",
  "aspectRatio": "9:16",
  "prompt": "生成一段 5 秒视频"
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 视频提示词 |
| `model` | 否 | `seedance_2_0_mini` 或 `seedance_2_0_fast` |
| `aspectRatio` | 否 | `9:16` 或 `16:9`；省略时默认 `16:9`，保存到任务并在豆包窗口发送前校验 |
| `referenceImage` | 否 | 上传的参考图片文件 |
| `referenceImagePath` | 否 | 本机参考图片绝对路径 |
| `referenceImageUrl` | 否 | 可下载的参考图片 URL |
| `callbackUrl` | 否 | 状态变化时接收 JSON 的回调地址 |
| `source` | 否 | 请求来源名称 |

生成请求固定执行最终 MP4 结果验证。去水印失败、平台不支持或没有取得可播放 MP4 时，任务状态为 `failed`。

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
| `accepted` | 已接收并进入队列 |
| `running` | 正在操作豆包或等待生成 |
| `success` | 已取得经过验证的 MP4 地址或本地 MP4 文件 |
| `failed` | 提交、生成、解析或 MP4 验证失败 |
| `stopped` | 任务已停止 |

## 终止任务并退回本地额度

```http
POST /api/requests/:requestId/stop
Authorization: Bearer <api-key>
```

仅允许终止 `accepted` 或 `running` 任务。程序会从本地队列移除任务或关闭对应执行窗口、释放账号，并且只退回一次该任务预扣额度；响应中的 `quotaRefunded` 表示额度是否已退回。若请求已经提交到豆包，该接口不会撤回豆包平台正在进行的生成。

## 恢复历史结果

```http
POST /api/requests/:requestId/retry-result
Authorization: Bearer <api-key>
```

该接口只重新查找并解析历史生成结果，不会再次提交视频生成，也不会重复扣除额度。

## 单独解析视频结果

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

## 成功语义

外部接口不会把豆包分享页、聊天页或 thread 页面地址当作视频结果。只有满足以下任一条件才返回 `status: "success"`：

- `cleanVideoUrl` 是经过验证、可访问的 MP4 视频地址。
- `outputVideoPath` 是已经保存成功的本地 `.mp4` 文件路径。
