// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button glass variant", () => {
  afterEach(cleanup);

  it("유리 면을 유지하고 테마별 hover 틴트만 더한다", () => {
    render(<Button variant="glass">Glass</Button>);
    const classes = screen.getByRole("button").className;

    expect(classes).toContain("bg-glass-tray");
    expect(classes).toContain("shadow-tray");
    expect(classes).toContain(
      "hover:[background:linear-gradient(var(--glass-tint-hover),var(--glass-tint-hover)),var(--glass-tray)]",
    );
    expect(classes).not.toContain("color-mix");
  });

  it("라이트 tray는 Figma의 불투명 흰색 변수를 쓴다", () => {
    const css = readFileSync("src/index.css", "utf8");

    expect(css).toMatch(/:root\s*\{[\s\S]*?--glass-tray:\s*#ffffff;/);
  });
});
