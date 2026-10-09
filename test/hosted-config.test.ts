/**
 * config.ts 的 hosted 增补（10-10 B 方案）：parseHostedRecallMode、hostedIntentUrl（…/v1 → /intent/v1）、
 * hostedRecallServer（endpointMode=hosted 且授权里 recallMode=server 才 true）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, hostedGrantPath, hostedIntentUrl, hostedRecallServer, parseHostedRecallMode, type HostedGrant } from "../src/config.ts";

const grant = (baseUrl: string): HostedGrant => ({
  baseUrl, apiKey: "ilk_x", model: "m", source: "env",
  limits: { recallConcurrency: 1, reasonConcurrency: 1, prewarmConcurrency: 1 },
  models: { swarm: "m", s4: "s4" },
});

describe("parseHostedRecallMode", () => {
  test("只有明确的 server 才算；其余（含老服务器不带）一律 client", () => {
    expect(parseHostedRecallMode("server")).toBe("server");
    expect(parseHostedRecallMode("client")).toBe("client");
    expect(parseHostedRecallMode(undefined)).toBe("client");
    expect(parseHostedRecallMode("magic", "server")).toBe("server"); // 坏值回退到上次
    expect(parseHostedRecallMode(undefined, "server")).toBe("server");
  });
});

describe("hostedIntentUrl", () => {
  test("授权 baseUrl（…/v1）去掉尾部 /v1 拼 /intent/v1", () => {
    expect(hostedIntentUrl(grant("https://api.example.com/v1"), "/intent/v1/recall")).toBe("https://api.example.com/intent/v1/recall");
    expect(hostedIntentUrl(grant("https://api.example.com/v1/"), "/intent/v1/recall")).toBe("https://api.example.com/intent/v1/recall");
    expect(hostedIntentUrl(grant("http://127.0.0.1:8800/v1"), "/intent/v1/pads")).toBe("http://127.0.0.1:8800/intent/v1/pads");
  });
});

describe("配置目录（公开树 intent-system / 私有树 intent-lab 并存，2026-10-11）", () => {
  const prev = { config: process.env.INTENT_LAB_CONFIG, dir: process.env.INTENT_LAB_CONFIG_DIR, home: process.env.HOME };
  const withEnv = (dir: string | undefined, home: string, fn: () => void): void => {
    const d = mkdtempSync(join(home, "cfgdir-"));
    delete process.env.INTENT_LAB_CONFIG;
    if (dir === undefined) delete process.env.INTENT_LAB_CONFIG_DIR;
    else process.env.INTENT_LAB_CONFIG_DIR = dir;
    process.env.HOME = d;
    try {
      fn();
    } finally {
      if (prev.config === undefined) delete process.env.INTENT_LAB_CONFIG;
      else process.env.INTENT_LAB_CONFIG = prev.config;
      if (prev.dir === undefined) delete process.env.INTENT_LAB_CONFIG_DIR;
      else process.env.INTENT_LAB_CONFIG_DIR = prev.dir;
      process.env.HOME = prev.home!;
    }
  };
  test("缺省 intent-lab；INTENT_LAB_CONFIG_DIR=intent-system 时整棵配置目录（含 hosted.json）跟着换", () => {
    withEnv(undefined, tmpdir(), () => {
      expect(configPath()).toBe(join(homedir(), ".config", "intent-lab", "config.json"));
      expect(hostedGrantPath()).toBe(join(homedir(), ".config", "intent-lab", "hosted.json"));
    });
    withEnv("intent-system", tmpdir(), () => {
      expect(configPath()).toBe(join(homedir(), ".config", "intent-system", "config.json"));
      expect(hostedGrantPath()).toBe(join(homedir(), ".config", "intent-system", "hosted.json"));
    });
  });
});

describe("hostedRecallServer", () => {
  const DIR = mkdtempSync(join(tmpdir(), "cfg-"));
  const CFG = join(DIR, "config.json");
  const prev = { config: process.env.INTENT_LAB_CONFIG, url: process.env.INTENT_LAB_HOSTED_URL, key: process.env.INTENT_LAB_HOSTED_KEY };
  beforeAll(() => {
    delete process.env.INTENT_LAB_HOSTED_URL;
    delete process.env.INTENT_LAB_HOSTED_KEY;
    process.env.INTENT_LAB_CONFIG = CFG;
  });
  afterAll(() => {
    if (prev.config === undefined) delete process.env.INTENT_LAB_CONFIG; else process.env.INTENT_LAB_CONFIG = prev.config;
    if (prev.url !== undefined) process.env.INTENT_LAB_HOSTED_URL = prev.url;
    if (prev.key !== undefined) process.env.INTENT_LAB_HOSTED_KEY = prev.key;
  });
  const writeMode = (endpointMode: string | null, recallMode?: string): void => {
    if (endpointMode === null) writeFileSync(CFG, JSON.stringify({ excludeSessions: [] }));
    else writeFileSync(CFG, JSON.stringify({ endpointMode, excludeSessions: [] }));
    writeFileSync(join(DIR, "hosted.json"), JSON.stringify({ baseUrl: "https://api.example/v1", apiKey: "ilk_x", model: "m", ...(recallMode ? { recallMode } : {}) }));
  };
  test("own 模式 / 没授权 / recallMode=client 都不算 server", () => {
    writeMode("own");
    expect(hostedRecallServer()).toBe(false);
    writeMode("hosted");
    expect(hostedRecallServer()).toBe(false); // 授权里没有 recallMode（老激活）
    writeMode("hosted", "client");
    expect(hostedRecallServer()).toBe(false);
    writeMode(null);
    expect(hostedRecallServer()).toBe(false);
  });
  test("hosted + recallMode=server 才 true", () => {
    writeMode("hosted", "server");
    expect(hostedRecallServer()).toBe(true);
  });
});
