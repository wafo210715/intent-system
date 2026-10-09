/**
 * intent-lab 服务入口（公开客户端树 · intent-system）：只注册「用我们的服务器」——召回编排在我们的
 * 服务器上跑（hosted 代理），本地不做任何模型调用，也不含打分提示词 / 阈值（那些只在我们服务器上）。
 * 私有树（完整版）的入口多注册一个本地编排驱动（recall-local.ts），见私有仓库。
 */
process.env.INTENT_LAB_CONFIG_DIR ??= "intent-system"; // 配置与授权在 ~/.config/intent-system/，与私有版（intent-lab）并存互不干扰

export * from "./server-core.ts";
import { asOfFromEnv, buildServer, refreshHostedLimits, startLocalSync, state } from "./server-core.ts";

if (import.meta.main) {
  state(); // 启动即加载持久层，坏行早发现
  try {
    const asOf = asOfFromEnv();
    if (asOf != null) console.log(`历史截止（INTENT_LAB_ASOF）：${asOf} = ${new Date(asOf + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 23)} GMT+8（只看这一刻之前的 QA 与表态）`);
  } catch (err) {
    console.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { port } = buildServer();
  void refreshHostedLimits(); // 用我们的服务器：启动时先拿一次服务器下发的并发 / 模型名 / 编排模式
  startLocalSync(); // 本机来源（Claude Code / Codex）：已同意的来源后台增量同步
  console.log(`intent-lab 服务已启动：http://127.0.0.1:${port}（数据都在本机 data/ 下，只追加）`);
}
