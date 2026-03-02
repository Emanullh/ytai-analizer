import { describe, expect, it } from "vitest";
import { getByPath } from "./getByPath";

describe("getByPath", () => {
  it("reads dotted paths", () => {
    const value = {
      thumbnailFeatures: {
        deterministic: {
          textAreaRatio: 0.23
        }
      }
    };

    expect(getByPath(value, "thumbnailFeatures.deterministic.textAreaRatio")).toBe(0.23);
  });

  it("reads array index paths", () => {
    const value = {
      rows: [{ id: "a" }, { id: "b" }]
    };

    expect(getByPath(value, "rows[1].id")).toBe("b");
    expect(getByPath(value, "rows.0.id")).toBe("a");
  });

  it("returns undefined when path is missing", () => {
    expect(getByPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getByPath(null, "a.b")).toBeUndefined();
    expect(getByPath({ a: 1 }, "")).toBeUndefined();
  });
});
