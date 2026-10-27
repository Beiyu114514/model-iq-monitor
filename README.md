# 模型智商/降智监测工具

轻量版，零 npm 依赖，Node.js ≥ 18 单进程运行。定时向自定义中转 API 提问并判定是否「降智」，展示条状历史图、统计和日志。

## 使用

1. 编辑 `config.json`：

```json
{
  "provider": {
    "baseUrl": "https://你的中转站/v1",   // 会拼上 /chat/completions
    "apiKey": "sk-xxx",
    "model": "gpt-4o",
    "timeoutMs": 60000
  },
  "intervalMinutes": 1,
  "retentionDays": 7,
  "port": 8787,
  "checkToken": "",
  "models": [
    { "id": "主力", "model": "gpt-4o", "enabled": true },
    { "id": "备用中转", "model": "claude-3-5", "baseUrl": "https://另一家中转/v1", "apiKey": "sk-yyy", "enabled": true }
  ],
  "questions": [
    {
      "id": "jp-pm",
      "question": "日本现任首相是谁？只回答名字。",
      "answerKeywords": ["高市早苗"],
      "enabled": true
    }
  ]
}
```

- **出题**：往 `questions` 加条目即可（或用后台 `/admin` 在线编辑），`answerKeywords` 是命中关键词数组（回答包含任意一个即算不降智），改完不用重启。
- **多模型**：`models` 数组支持自定义检测模型，每个可单独覆盖 `baseUrl` / `apiKey`（留空用通用 provider），每轮对「启用问题 × 启用模型」全组合检测。未配置 `models` 时沿用 `provider.model` 单模型。
- 多个问题会每轮依次全部检测；历史区显示 60 根状态条（24 小时视图每根 24 分钟，3 天视图每根 72 分钟）。
- `intervalMinutes` 同样支持热更新，改完不用重启。
- **公网部署**：给 `checkToken` 设一个随机字符串，`POST /api/check` 需要带 `?token=xxx`（或 `x-check-token` 头）才会执行，防止别人刷你的 API 额度。面板地址栏加 `?token=xxx` 会自动记住。
- **后台 `/admin`**：`checkToken` 只能用于触发手动检测，不能进入后台。后台需要 `adminToken`（请求头 `x-admin-token` 或 `?token=`）；未配置 `adminToken` 时仅允许本机访问（带 `X-Forwarded-For` / `Forwarded` 的请求视为非本机，避免同机反代把后台暴露到公网）。仓库里的 `checkToken` 默认为空，公网部署前请自行设置。后台读取的 API Key 一律打码；改了模型 ID 或模型名后若无法对应，保存会提示重新填写 Key，不会套用别的模型的密钥。
- 数据文件每天自动压缩一次，超过 `retentionDays` 的旧记录会被清理。

2. 启动：

```bash
node server.js
```

打开 http://localhost:8787 即可。数据存 `data/checks.jsonl`，超过保留期自动忽略。

## API

- `GET /api/summary` — 24h 不降智率、平均响应、最近一次检测
- `GET /api/history?range=24h|3d` — 按 10 分钟聚合的历史数据，加 `&points=60` 可平均切成固定数量的状态条
- `GET /api/logs?limit=60` — 最近日志
- `POST /api/check` — 手动触发一次检测

## 部署

```bash
nohup node server.js > monitor.log 2>&1 &
# 或 pm2 start server.js --name iq-monitor
```

Docker 可自行用 `node:22-alpine` 包一层，无需安装依赖。
