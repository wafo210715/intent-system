import { describe, expect, test } from "bun:test";
import { parseSmallNumber, resolveRelativeTimes } from "../src/time-resolve.ts";

// 锚点：2026-09-24（周四）21:00 GMT+8
const ANCHOR = Date.parse("2026-09-24T21:00:00+08:00");
const vals = (text: string) => resolveRelativeTimes(text, ANCHOR).map((r) => `${r.text}=${r.value}`);

describe("相对时间换算", () => {
  test("单字日", () => {
    expect(vals("继续昨天的架构讨论")).toEqual(["昨天=2026-09-23"]);
    expect(vals("前天和大前天")).toEqual(["前天=2026-09-22", "大前天=2026-09-21"]);
    expect(vals("明天后天")).toEqual(["明天=2026-09-25", "后天=2026-09-26"]);
  });

  test("周：整周与周内具体日", () => {
    expect(vals("上周的会议")).toEqual(["上周=2026-09-14..2026-09-20"]);
    expect(vals("上周三说过")).toEqual(["上周三=2026-09-16"]);
    expect(vals("这周五交")).toEqual(["这周五=2026-09-25"]);
    expect(vals("下礼拜一")).toEqual(["下礼拜一=2026-09-28"]);
  });

  test("月、年、N 天前", () => {
    expect(vals("上个月的周报")).toEqual(["上个月=2026-08"]);
    expect(vals("去年")).toEqual(["去年=2025"]);
    expect(vals("三天前")).toEqual(["三天前=2026-09-21"]);
    expect(vals("2周前")).toEqual(["2周前=2026-09-10"]);
  });

  test("具体日期取锚点年份", () => {
    expect(vals("9月21日的会议")).toEqual(["9月21日=2026-09-21"]);
    expect(vals("八月十二号")).toEqual(["八月十二号=2026-08-12"]);
  });

  test("落在四个月以后的日期当作去年", () => {
    const june = Date.parse("2026-06-08T12:00:00+08:00");
    expect(resolveRelativeTimes("从12月25号一直到6月8号", june).map((r) => r.value)).toEqual(["2025-12-25", "2026-06-08"]);
  });

  test("截止说法不当成 N 天以前", () => {
    expect(vals("选项：4月14日前完成")).toEqual(["4月14日=2026-04-14"]);
    expect(vals("屆满五日前提出")).toEqual([]);
  });

  test("引用块里的相对时间不换算", () => {
    expect(vals('<quoted_context source="x">上周他还住在北京</quoted_context> 昨天说的那个')).toEqual(["昨天=2026-09-23"]);
  });

  test("不该换算的", () => {
    expect(vals("晚上周一开会")).toEqual([]); // "上周一"前面是"晚"
    expect(vals("看一下周报")).toEqual([]); // "下周"后面是"报"
    expect(vals("周一例会")).toEqual([]); // 裸周几不猜
    expect(vals("晚上月亮很圆")).toEqual([]);
  });

  test("英文", () => {
    expect(vals("as we said yesterday")).toEqual(["yesterday=2026-09-23"]);
    expect(vals("last week")).toEqual(["last week=2026-09-14..2026-09-20"]);
  });

  test("跨零点按 GMT+8 取日", () => {
    // UTC 16:30 = GMT+8 次日 00:30
    const ts = Date.parse("2026-09-24T16:30:00Z");
    expect(resolveRelativeTimes("昨天", ts)[0]?.value).toBe("2026-09-24");
  });

  test("中文小数字", () => {
    expect(parseSmallNumber("十二")).toBe(12);
    expect(parseSmallNumber("二十三")).toBe(23);
    expect(parseSmallNumber("7")).toBe(7);
  });
});
