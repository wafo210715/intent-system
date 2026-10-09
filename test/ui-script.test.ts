/**
 * 管理页 ui/index.html 的内联脚本语法防线（2026-10-12）：
 * 页面脚本一旦混进 TS 语法（as 断言、类型注解…），浏览器整段 SyntaxError、页面空白——
 * 离线测试与导出链各查一遍：抽出全部 <script> 内容用 new Function 编译（只编译不执行）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) out.push(m[1]!);
  return out;
}

describe("管理页内联脚本语法（混进 TS 语法 = 浏览器整段崩、页面空白）", () => {
  test("ui/index.html 的每个 <script> 都能用 new Function 编译通过", () => {
    const html = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const [i, code] of scripts.entries()) {
      expect(() => {
        try {
          new Function(code);
        } catch (err) {
          throw new Error(`第 ${i + 1} 段 <script> 编译失败：${err instanceof Error ? err.message : String(err)}（八成是混进了 TS 语法）`);
        }
      }).not.toThrow();
    }
  });
});
