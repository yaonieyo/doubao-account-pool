# 豆包账号池

豆包账号池是一款基于 Electron 的本地桌面工具，用于管理多个相互隔离的豆包登录环境，并通过本地 HTTP API 为无限画布或其他工作流提供视频生成能力。

当前修复版本：`0.1.38`

## 版本策略

- `v0.1.30`：稳定回退版，保留在 Git 标签和 Releases，不覆盖。
- `v0.1.36`：稳定回退版，包含 Mini/Fast 模型切换修复，保留在 Git 标签和 Releases，不覆盖。
- `v0.1.38`：当前修复版，新增豆包新版提交确认、违规原文回传和“仍在生成”安全等待。

## 主要功能

- 多账号隔离：每个账号使用固定的 Electron `persist:` partition，Cookie、LocalStorage、缓存和登录状态互不混用。
- 登录持久化：关闭软件后保留各账号登录状态，下次启动可继续使用。
- 共享额度管理：默认每个账号每日 10 点额度，Mini 消耗 2 点，Fast 消耗 3 点，均可在配置页调整。
- 账号池调度：自动选择已登录、空闲且额度充足的账号执行请求。
- 后台视频生成：支持文本提示词和参考图片，跟踪等待、执行、成功和失败状态。
- 严格结果输出：只有取得经过验证的真实 MP4 地址或本地 MP4 文件后，任务才会返回 `success`。
- 可选去水印：可配置第三方解析接口；只在取得并验证 MP4 后返回 `success`，解析失败或未取得 MP4 时返回 `failed`。
- 本地接口服务：默认监听 `127.0.0.1:17888`，支持 API Key、状态查询和回调地址。
- 可观测界面：提供账号概览、剩余额度、Mini/Fast 预计产能、搜索筛选和接口日志详情。
- 行动日志：逐步记录账号、任务、分享地址、去水印和错误信息，默认保留 3 天并自动清理。
- 结果恢复与诊断：支持从账号最近对话恢复已生成视频，日志显示分享复制、去水印重试和耗时信息。
- 跨平台安装包：提供 macOS Apple Silicon DMG 和 Windows x64 EXE。

## 下载与安装

请从 [Releases](../../releases/latest) 下载当前版本：

- macOS Apple Silicon：下载 `0.1.30` ARM64 DMG 或 ZIP。
- Windows x64：下载 `0.1.30` Windows x64 EXE。

macOS 应用已进行完整 ad-hoc 签名，避免因 Electron 临时签名不完整而显示“应用已损坏”。当前安装包尚未使用 Apple Developer ID 公证或 Windows 商业代码签名，Gatekeeper 或 SmartScreen 首次运行时仍可能显示来源提示。请核对发布页中的 SHA-256；macOS 首次尝试打开后，可进入“系统设置 > 隐私与安全性”，在安全性区域选择“仍要打开”。

## 快速开始

1. 安装并启动应用。
2. 点击“添加账号”，在打开的独立豆包窗口中完成登录。
3. 返回账号池执行检测，确认账号显示为“已登录”和“空闲”。
4. 在“配置管理”中设置 API Key、模型额度、执行策略、去水印 Token 和输出目录。
5. 从无限画布或其他本地工作流调用生成接口。

## 本地 API

默认地址：`http://127.0.0.1:17888`

```bash
curl -X POST http://127.0.0.1:17888/api/generate \
  -H "Authorization: Bearer local-doubao-key" \
  -F "model=seedance_2_0_mini" \
  -F "prompt=生成一段 10 秒科普视频" \
  -F "referenceImage=@/path/to/reference.png" \
  -F "callbackUrl=http://127.0.0.1:3000/doubao/callback"
```

提交成功会先返回 `accepted`，可通过下面的接口查询：

```bash
curl http://127.0.0.1:17888/api/requests/doubao-xxxxxxxxxxxxxxxx \
  -H "Authorization: Bearer local-doubao-key"
```

成功结果只包含最终可用的视频字段：

```json
{
  "requestId": "doubao-xxxxxxxxxxxxxxxx",
  "status": "success",
  "message": "视频生成完成，去水印 MP4 地址已验证（耗时 X 秒，第 N 次解析）",
  "model": "seedance_2_0_mini",
  "cleanVideoUrl": "https://example.com/video.mp4",
  "outputVideoPath": null
}
```

完整接口说明见 [docs/API.md](docs/API.md)。

第一次使用、连接无限画布和排错请先阅读 [新手使用手册](docs/USER_GUIDE.md)。

## 数据位置

运行数据不会提交到仓库：

- macOS：`~/Library/Application Support/doubao-account-manager/`
- Windows：`%APPDATA%/doubao-account-manager/`

SQLite 数据库、账号 partition、Cookie、缓存、上传参考图和登录状态均保存在对应系统用户目录。

## 本地开发

环境要求：Node.js 20 或更高版本。

```bash
npm ci
npm run dev
```

常用命令：

```bash
npm run typecheck  # TypeScript 检查
npm run build      # 生产构建
npm run dist       # macOS 安装包
npm run dist:win   # Windows x64 安装包
```

## 技术栈

- Electron
- Vue 3
- TypeScript
- SQLite / better-sqlite3
- Vite
- electron-builder

## 使用边界

本项目不提供自动注册、验证码处理、账号限制绕过或平台风控规避。请遵守豆包及相关第三方服务的使用规则，仅在本人拥有权限的账号和内容上使用。

本项目是非官方本地工具，与豆包或字节跳动不存在隶属、授权或合作关系。

## 更新记录

版本变化见 [CHANGELOG.md](CHANGELOG.md)。
