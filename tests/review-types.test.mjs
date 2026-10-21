import { describe, expect, it } from "vitest";
import { applyOperations, emptyReview, formatReview, normalizeType, ofType, parseReview, shareType } from "../server/review-data.mjs";

describe("review types", () => {
  it("are a category or a category and a subcategory", () => {
    expect(normalizeType(" 剧情音乐短片 ")).toBe("剧情音乐短片");
    expect(normalizeType("剧情音乐短片 /  s0rrow")).toBe("剧情音乐短片/s0rrow");
    expect(normalizeType("a/b/c")).toBeNull();
    expect(normalizeType("/s0rrow")).toBeNull();
    expect(normalizeType("")).toBeNull();
  });

  it("put a work in its types and their categories, never in another type", () => {
    expect(ofType(["剧情音乐短片/s0rrow"], "剧情音乐短片")).toBe(true);
    expect(ofType(["剧情音乐短片/s0rrow"], "剧情音乐短片/s0rrow")).toBe(true);
    expect(ofType(["剧情音乐短片"], "剧情音乐短片/s0rrow")).toBe(false);
    expect(ofType(["剧情音乐短片/s0rrow"], "剧情音乐短片/伤感")).toBe(false);
    expect(ofType(["剧情音乐短片2"], "剧情音乐短片")).toBe(false);
    expect(ofType([], "剧情音乐短片")).toBe(false);
    // Several types: a work is in each of them.
    expect(ofType(["体素音乐视频", "剧情音乐短片/s0rrow"], "体素音乐视频")).toBe(true);
    expect(shareType(["剧情音乐短片/s0rrow"], ["剧情音乐短片"])).toBe(true);
    expect(shareType(["剧情音乐短片/s0rrow"], ["剧情音乐短片/伤感"])).toBe(false);
    expect(shareType([], ["剧情音乐短片"])).toBe(false);
  });

  it("are kept in review.json, set as a whole", () => {
    const review = emptyReview("w1");
    const { results, changes } = applyOperations(review, [{ op: "types", types: ["剧情音乐短片/s0rrow", "剧情音乐短片 / s0rrow", "体素音乐视频"] }]);
    expect(results[0].status).toBe("ok");
    expect(changes).toEqual(["类型：剧情音乐短片/s0rrow、体素音乐视频"]);
    const again = parseReview(formatReview(review), "w1");
    expect(again.types).toEqual(["剧情音乐短片/s0rrow", "体素音乐视频"]);
    expect(applyOperations(again, [{ op: "types", types: [] }]).changes).toEqual(["清除类型"]);
    expect(again.types).toEqual([]);
    // A hand-edited file with a bad entry keeps the good ones.
    expect(parseReview(JSON.stringify({ types: ["好的/类型", "坏/的/类型", 3] }), "w1").types).toEqual(["好的/类型"]);
  });
});
