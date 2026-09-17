// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { HoverMenuButton } from "@/components/ui/hover-menu-button";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HoverMenuButton", () => {
  it("uses an aria-only trigger label instead of a competing native tooltip", () => {
    render(
      <HoverMenuButton title="Add to workspace" icon={<Plus />}>
        <DropdownMenuItem>Add agent</DropdownMenuItem>
      </HoverMenuButton>,
    );
    const trigger = screen.getByRole("button", { name: "Add to workspace" });

    expect(trigger.getAttribute("aria-label")).toBe("Add to workspace");
    expect(trigger.getAttribute("title")).toBe("");
  });

  it("keeps a hover-opened menu when its trigger is pressed, and closes it on the next press", async () => {
    render(
      <HoverMenuButton title="Add to workspace" icon={<Plus />}>
        <DropdownMenuItem>Add agent</DropdownMenuItem>
      </HoverMenuButton>,
    );
    const trigger = screen.getByRole("button", { name: "Add to workspace" });

    // The pointer arrives and rests: the menu opens after the hover delay.
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    // Radix attaches its outside-press listener a tick after the menu mounts.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Pressing what you are pointing at commits the menu — the natural
    // reflex must not take it away (owner decision 2026-09-03).
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("menu")).toBe(menu);

    // A pinned menu still toggles: the next press closes it.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("owns lower-right menu placement for every consumer", async () => {
    render(
      <HoverMenuButton title="Add to workspace" icon={<Plus />}>
        <DropdownMenuItem>Add agent</DropdownMenuItem>
      </HoverMenuButton>,
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Add to workspace" }),
      { button: 0, ctrlKey: false },
    );

    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(menu.getAttribute("data-align")).toBe("start");
  });
});
