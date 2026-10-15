/**
 * intent-mcp 入口：stdio MCP server。后端是本机 intent 服务（见 client.ts 头注）。
 *
 * 注册（Proma / Claude Code / 任何 MCP 客户端）：
 *   command: bun   args: ["run", "<本目录>/index.ts"]
 *   环境变量 INTENT_MCP_URL 可改后端地址（缺省 http://127.0.0.1:8723）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  intentFeedback,
  intentHealth,
  intentIngest,
  intentRecall,
  intentSources,
  intentSync,
} from "./client.ts";

const server = new McpServer({ name: "intent-mcp", version: "0.1.0" });

const asJson = (v: unknown): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
});
const asError = (err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

server.registerTool(
  "intent_health",
  {
    description:
      "意图系统体检：确认本机服务在不在、是否已激活、库里有多少条历史 QA、各模型端点、应用开关。召回前先调它；ok=false 时按 hint 引导（没启动 → bun run serve；needsActivation → 去管理页 /ui 激活）。",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      return asJson(await intentHealth());
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "intent_recall",
  {
    description:
      "意图召回：用户发问时调用。把用户原话发给本机意图服务，它从历史对话里找出真正相关的 QA 并整理成上下文。" +
      "返回 status=done 时：injection 是召回的上下文（回答时按需参考，用不上就忽略；needsFeedback=true 时为「全部不表态」临时版）；" +
      "review.asks 非空或 needsFeedback=true 时，先把每条 ask 的 statement 拿给用户确认（对/不对/可改字），再调 intent_feedback 拿最终 injection。" +
      "status=skipped 表示门卫判定这句不需要意图分析（寒暄/短确认），直接回答即可，也可用 force=true 重跑。" +
      "status=error 且 retryable=true 可重试（服务会接着上次的进度）。召回可能跑几十秒到几十分钟，调用方不要设短超时。" +
      "sessionId 用当前会话的稳定 id（同一会话始终同一个，影响确认卡分轮与上下文文件）；turnId 用本轮用户消息的稳定 id（供 /ingest 与 /invalidate 对齐，缺省自动生成）。",
    inputSchema: z.object({
      q: z.string().describe("用户原话，不含任何注入/系统包装"),
      sessionId: z.string().describe("当前会话的稳定 id"),
      turnId: z.string().optional().describe("本轮用户消息的稳定 id；缺省自动生成"),
      title: z.string().optional().describe("会话标题"),
      force: z.boolean().optional().describe("true = 跳过门卫强制做意图分析"),
      contextInlineMax: z.number().optional().describe("done.context.md 内联返回的字符上限（缺省 40000；0 = 不内联）"),
    }),
  },
  async (args) => {
    try {
      return asJson(await intentRecall(args));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "intent_feedback",
  {
    description:
      "确认卡表态：intent_recall 返回 needsFeedback=true 后，把用户对每条 ask 的表态送回来，换最终 injection 与更新后的上下文文件。verdict：yes=对、no=不对、skip=不表态；edited=用户改过的陈述（可与任何 verdict 并存）；note=用户补的一句背景。runId 过期（404）按提示重跑 intent_recall。",
    inputSchema: z.object({
      runId: z.string(),
      answers: z.array(
        z.object({
          askId: z.string(),
          verdict: z.enum(["yes", "no", "skip"]),
          edited: z.string().optional(),
        }),
      ),
      note: z.string().optional(),
    }),
  },
  async (args) => {
    try {
      return asJson(await intentFeedback(args));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "intent_ingest",
  {
    description:
      "一轮回答正常结束后回写：把这轮的（用户原话, 助手回答）入库，供以后召回。出错、取消、没回答的轮不要调。turnId 必须与 intent_recall 用的一致（幂等去重键）；内容变了会作废旧行按新内容入库。",
    inputSchema: z.object({
      sessionId: z.string(),
      turnId: z.string().describe("与 intent_recall 相同的 turnId"),
      title: z.string().optional(),
      q: z.string().describe("用户原话"),
      a: z.string().describe("助手这一轮最后的文字回答，没有就空串"),
      ts: z.number().optional().describe("用户消息原来的时间（毫秒），缺省取现在"),
    }),
  },
  async (args) => {
    try {
      return asJson(await intentIngest(args));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "intent_sync",
  {
    description:
      "增量同步本机来源（claude / codex / proma 的会话文件）进意图库：召回前调一次，保证最新对话参与召回。mode=sync 只送变化的文件（秒级）；full 全量重送（幂等，慢）。首次使用某来源前需要在管理页 /ui 同意导入。",
    inputSchema: z.object({
      source: z.enum(["claude", "codex", "proma"]),
      mode: z.enum(["sync", "full"]).optional(),
      wait: z.boolean().optional().describe("缺省 true：等任务结束再返回（最多 10 分钟）"),
    }),
  },
  async (args) => {
    try {
      return asJson(await intentSync(args));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "intent_sources",
  {
    description: "查看各本机来源的入库状态：发现多少会话/QA、已入库与参与召回的条数、同步任务进度、按项目的排除情况（明细管理去 /ui）。",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      return asJson(await intentSources());
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
