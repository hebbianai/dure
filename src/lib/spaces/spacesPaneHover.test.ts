import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSpacesPaneHover,
  getSpacesPaneHover,
  setSpacesPaneHover,
  spacesPaneHoverKey,
  subscribeSpacesPaneHover,
} from "@/lib/spaces/spacesPaneHover";

describe("spacesPaneHover", () => {
  beforeEach(() => {
    clearSpacesPaneHover();
  });

  it("publishes one exact desktop and pane identity", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpacesPaneHover(listener);

    const target = spacesPaneHoverKey("desktop-1", "term:one");
    setSpacesPaneHover(target);

    expect(getSpacesPaneHover()).toBe(target);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not let a stale leave clear the newer pane hover", () => {
    const first = spacesPaneHoverKey("desktop-1", "term:one");
    const second = spacesPaneHoverKey("desktop-1", "term:two");

    setSpacesPaneHover(first);
    setSpacesPaneHover(second);
    clearSpacesPaneHover(first);

    expect(getSpacesPaneHover()).toBe(second);
    clearSpacesPaneHover(second);
    expect(getSpacesPaneHover()).toBeNull();
  });

  it("keeps desktop identities separate for equal pane ids", () => {
    expect(spacesPaneHoverKey("desktop-1", "term:shared")).not.toBe(
      spacesPaneHoverKey("desktop-2", "term:shared"),
    );
  });
});
