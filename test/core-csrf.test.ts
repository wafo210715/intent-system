/**
 * 核心写接口 CSRF（Host + Origin）：与 /local/* 同一套 localGuard。
 * 恶意 Origin / 非本机 Host → 403；插件·curl 无 Origin、同站 Origin 照常放行（业务错误另计）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, resetPersisted } from "../src/server.ts";

const ROOT = mkdtempSync(join(tmpdir(), "intent-csrf-"));
const DATA = join(ROOT, "data");
let svc: { port: number; stop: () => void } | null = null;
const saved: Record<string, string | undefined> = {};
const ENV = ["INTENT_LAB_DATA", "INTENT_LAB_CONFIG", "INTENT_LAB_SOURCE"];

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  mkdirSync(DATA, { recursive: true });
  process.env.INTENT_LAB_DATA = DATA;
  process.env.INTENT_LAB_CONFIG = join(ROOT, "none.json");
  process.env.INTENT_LAB_SOURCE = "orbita";
  resetPersisted();
  svc = buildServer(0);
});

afterAll(() => {
  svc?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetPersisted();
});

const base = (): string => `http://127.0.0.1:${svc!.port}`;
const post = async (p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(base() + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const CORE = ["/recall", "/feedback", "/import", "/reset", "/ingest", "/invalidate"] as const;

describe("核心写接口 CSRF（localGuard）", () => {
  test("恶意 Origin 的 POST 一律 403（含 /reset）", async () => {
    for (const path of CORE) {
      const r = await post(path, {}, { origin: "https://evil.example" });
      expect(r.status).toBe(403);
      const j = await r.json();
      expect(j.error).toContain("跨站");
    }
  });

  test("非本机 Host 被拒", async () => {
    const r = await fetch(base() + "/reset", {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example" },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  test("无 Origin（插件 / curl）与同站 Origin 不因 CSRF 拦下", async () => {
    // 故意用不完整 body：过了 localGuard 后应是业务 4xx，绝不是 403
    const noOrigin = await post("/feedback", {});
    expect(noOrigin.status).not.toBe(403);
    expect(noOrigin.status).toBeGreaterThanOrEqual(400);

    const same = await post("/invalidate", { sessionId: "s", turnIds: [] }, { origin: base() });
    expect(same.status).not.toBe(403);

    const ingest = await post("/ingest", { sessionId: "s" }); // 缺字段 → 业务错
    expect(ingest.status).not.toBe(403);
    expect(ingest.status).toBeGreaterThanOrEqual(400);
  });

  test("/health 仍可无防护读取；/local/clear 恶意 Origin 仍 403（对照）", async () => {
    expect((await fetch(base() + "/health")).status).toBe(200);
    expect((await post("/local/clear", { source: "codex" }, { origin: "https://evil.example" })).status).toBe(403);
  });
});
