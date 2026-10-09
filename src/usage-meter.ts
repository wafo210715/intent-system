/**
 * 按环节记 token：每次模型调用成功后，把 usage 记到它所属的环节下。
 * 环节：gate（门卫）/ s1（意图识别）/ s3_score（S3 第一步打分）/ s3_reason（S3 第二步写理由）/ s4（守门员）。
 * 只做记录，不改调用本身；不进 wire 契约（写 data/runs/<run>/usage.json + 服务端日志）。
 */
import type { ChatMessage, JsonCaller, Usage } from "./llm.ts";

export interface StageUsage {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** 思考 token（多数网关已含在 completionTokens 里，这里单列方便看） */
  thinkingTokens: number;
}

export class UsageMeter {
  readonly by: Record<string, StageUsage> = {};

  add(stage: string, u: Usage): void {
    const s = (this.by[stage] ??= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, thinkingTokens: 0 });
    s.calls++;
    s.promptTokens += u.promptTokens;
    s.cachedTokens += u.cachedTokens;
    s.completionTokens += u.completionTokens;
    s.thinkingTokens += u.thinkingTokens;
  }

  /** 包一层：调用成功后按 stageOf(messages) 记账 */
  tap(call: JsonCaller, stageOf: (messages: ChatMessage[]) => string): JsonCaller {
    return (async (messages: ChatMessage[], opts?: Parameters<JsonCaller>[1]) => {
      const res = await call(messages, opts);
      this.add(stageOf(messages), res.usage);
      return res;
    }) as JsonCaller;
  }

  total(): StageUsage {
    const t: StageUsage = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, thinkingTokens: 0 };
    for (const s of Object.values(this.by)) for (const k of Object.keys(t) as Array<keyof StageUsage>) t[k] += s[k];
    return t;
  }

  /** 一行摘要（服务端日志用）。缓存命中数也报（10-08 DeepSeek 预设：前缀缓存命中率看这里）——为 0 时省略，本地 vLLM 日志不变 */
  line(): string {
    return Object.entries(this.by).map(([k, s]) => `${k}:${s.calls}次/入${s.promptTokens}${s.cachedTokens > 0 ? `(缓存${s.cachedTokens})` : ""}/出${s.completionTokens}`).join(" ");
  }
}
