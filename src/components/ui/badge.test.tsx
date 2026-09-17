// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";

const badgeOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe("Badge size axis", () => {
  afterEach(cleanup);

  it("기본 크기는 기존 h-5 알약 형태를 그대로 유지한다", () => {
    const { container } = render(<Badge>기본</Badge>);
    const classes = badgeOf(container).className;

    expect(classes).toContain("h-5");
    expect(classes).toContain("rounded-4xl");
    expect(classes).toContain("text-xs");
  });

  it("sm은 tailwind-merge로 base의 h-5/rounded-4xl/text-xs를 이긴다", () => {
    const { container } = render(
      <Badge size="sm" variant="secondary">
        미니
      </Badge>,
    );
    const classes = badgeOf(container).className;

    expect(classes).toContain("h-auto");
    expect(classes).toContain("rounded-md");
    expect(classes).toContain("text-[10px]");
    expect(classes).toContain("px-2");
    expect(classes).toContain("py-0.5");
    // The conflicting base sizing classes must not survive the merge.
    expect(classes).not.toContain("h-5");
    expect(classes).not.toContain("rounded-4xl");
    expect(classes).not.toMatch(/\btext-xs\b/);
    // The size axis composes with the variant axis instead of replacing it.
    expect(classes).toContain("bg-foreground/8");
  });
});
