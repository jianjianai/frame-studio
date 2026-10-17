import { describe, expect, it } from "vitest";
import { joinSpoken, placeSpoken } from "../web/chat/spoken";

describe("dictated text", () => {
  it("joins sentences with a space only where the language uses spaces", () => {
    expect(joinSpoken(["开场标题再大一点。", "两秒处加闪白。"])).toBe("开场标题再大一点。两秒处加闪白。");
    expect(joinSpoken(["Make it bigger.", "Then export."])).toBe("Make it bigger. Then export.");
    expect(joinSpoken(["换成轻快的音乐。", "Then export."])).toBe("换成轻快的音乐。Then export.");
    expect(joinSpoken(["", "你好。"])).toBe("你好。");
  });

  it("goes in at the cursor and leaves the cursor after it", () => {
    expect(placeSpoken("把标题改成", "红色。", "然后保存")).toEqual({ text: "把标题改成红色。然后保存", cursor: "把标题改成红色。".length });
    expect(placeSpoken("Make it", "bigger.", "")).toEqual({ text: "Make it bigger.", cursor: 15 });
    expect(placeSpoken("Make it ", "bigger.", "")).toEqual({ text: "Make it bigger.", cursor: 15 });
    expect(placeSpoken("", "", "原来的文字")).toEqual({ text: "原来的文字", cursor: 0 });
  });
});
