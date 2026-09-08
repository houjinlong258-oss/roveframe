# RoveAgent Core

RoveFrame AI Business OS 的原生 AI 运行时内核。

- **Agent Runtime**：自主 Agent Loop、流式 tool calling、上下文压缩、多模型合议（MoA）
- **130+ 工具**：终端/文件/浏览器/代码执行/委托，统一经 `tools.framework.EnterpriseToolGate` 企业门控（Schema→权限→审批→审计）
- **Skill 自学习闭环**：复杂任务后自动生成技能，使用中自我改进，内置 lint/AST 审计/用量评估
- **FTS5 会话记忆搜索**：`state/` SQLite+FTS5；`state.enterprise_memory.EnterpriseMemory` 提供 L0–L4 分层租户隔离记忆
- **渠道网关**：Telegram / Discord / Slack / WhatsApp / Matrix / Teams 等 23 平台（`plugins/platforms/`），单网关进程
- **子代理并行**：`core.subagent_lifecycle` + `tools.delegate_tool`，隔离工作树并行执行
- **定时任务**：`cron/` 自然语言例行工作（每日简报、巡检）
- **多模型**：OpenAI / Claude / Gemini / DeepSeek / 本地模型，运行时切换

## 与 RoveFrame（TS/Next.js）集成

TS 侧通过网关内置 HTTP API（`roveagent.gateway.platforms.api_server`）与 Python 运行时通信：

```
RoveFrame (Next.js)  ──HTTP/webhook──▶  roveagent gateway api_server  ──▶  Agent Loop
```

## 合规

第三方版权与许可信息集中保留在 `LICENSE` 与 `NOTICE`。

## 快速验证

```bash
python -c "from roveagent import EnterpriseToolGate, EnterpriseMemory; print('roveagent OK')"
```
