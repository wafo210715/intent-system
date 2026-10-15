# intent-mcp（意图系统 MCP 适配）

把本机 intent 服务（`127.0.0.1:8723`，契约 v6）封装成 MCP 工具，让任何会调 MCP 的 agent（Proma / Claude Code / Codex）用上意图召回。

- **后端**：intent-system 的本地服务（`bun run serve`），历史与配置全在本机；
- **管理**：服务自带的管理页 `http://127.0.0.1:8723/ui`（激活、来源导入、预热、表态记录都在那里）；
- **本包**：只做消费端接入，无状态，后端没起来时给可操作的中文错误。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `intent_health` | 体检：服务在不在、是否激活、QA 数、模型端点、应用开关 |
| `intent_recall` | 召回：用户原话 → NDJSON 流归约 → injection / review / asks / 上下文文件 |
| `intent_feedback` | 确认卡表态（yes/no/skip/改字/补背景）→ 最终 injection |
| `intent_ingest` | 回答正常结束后回写本轮 QA（出错/取消的轮不调） |
| `intent_sync` | 增量同步本机来源（claude / codex / proma）进意图库 |
| `intent_sources` | 各来源的入库与同步状态 |

## Agent 侧的一轮（纪律）

1. `intent_health` —— `ok=false` 按 hint 处理（没启动 / 未激活）；
2. `intent_sync`（可选，建议）—— 让最新对话参与召回；
3. `intent_recall` —— `sessionId` 用当前会话稳定 id；`turnId` 本轮消息稳定 id（与 ingest 对齐）。**召回可能跑几十秒到几十分钟，不要给调用设短超时**；
4. `needsFeedback=true` 或有 `asks` —— 逐条拿给用户确认后调 `intent_feedback` 换最终 injection；
5. 回答用户（injection 按需参考，用不上就忽略）；
6. `intent_ingest` —— 正常结束后回写；`status=skipped`（门卫放行）的轮不用召回但照常 ingest。

> 与 Claude Code 插件的差别：插件用 hook 硬拦截每句话；MCP 是软集成，靠 agent 自觉遵守上面的顺序。建议在 agent 的系统提示 / Skill 里写明这条纪律。

## 注册

任何支持 stdio MCP 的客户端：

```json
{
  "command": "bun",
  "args": ["run", "/absolute/path/to/adapters/mcp/intent-mcp/index.ts"]
}
```

环境变量 `INTENT_MCP_URL` 改后端地址（缺省 `http://127.0.0.1:8723`）。

**工具超时要调大**：`intent_recall` 可能跑几十秒到几十分钟（客户端兜底上限 45 分钟），`intent_sync` 带 `wait` 时最多等 10 分钟。很多 MCP 客户端默认的工具超时只有一两分钟，超时后会断开，服务侧也会取消本轮召回。注册时把该客户端的 MCP 工具超时调到 45 分钟以上（例如 Claude Code 设环境变量 `MCP_TOOL_TIMEOUT=2700000`，单位毫秒）。

## 开发

```bash
bun install && bun test   # stub 服务测试，不打真模型、不需要本机服务
```
