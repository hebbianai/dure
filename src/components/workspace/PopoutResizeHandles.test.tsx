// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startResizeDragging = vi.fn(async () => {});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startResizeDragging }),
}));

import { PopoutResizeHandles } from "@/components/workspace/PopoutResizeHandles";

describe("PopoutResizeHandles", () => {
  beforeEach(() => startResizeDragging.mockClear());

  it("starts native resizing in the selected direction", () => {
    const { container } = render(<PopoutResizeHandles />);
    const handle = container.querySelector<HTMLElement>(
      '[data-popout-resize-direction="SouthEast"]',
    );
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle as HTMLElement, { button: 0 });
    expect(startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });
});
