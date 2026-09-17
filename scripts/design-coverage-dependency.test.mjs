import { generate, parse, version, walk } from "css-tree";
import { describe, expect, it } from "vitest";

describe("design coverage css-tree dependency", () => {
  it("keeps the pinned parser and generator contract executable", () => {
    const stylesheet = parse("a { color: #fff; margin: 0 1px }");
    const properties = [];

    walk(stylesheet, {
      enter(node) {
        if (node.type === "Declaration") properties.push(node.property);
      },
    });

    expect(version).toBe("3.2.1");
    expect(properties).toEqual(["color", "margin"]);
    expect(generate(stylesheet)).toBe("a{color:#fff;margin:0 1px}");
  });
});
