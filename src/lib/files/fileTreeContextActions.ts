import type { DesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";

export type FileTreeContextAction =
  | "open-directory-window"
  | "reveal-in-finder"
  | "share"
  | "delete-permanently";

export function fileTreeContextActions(input: {
  source: "local" | "ssh";
  isDirectory: boolean;
  platform: DesktopPlatform;
}): FileTreeContextAction[] {
  if (input.source === "ssh") return ["delete-permanently"];
  return [
    ...(input.isDirectory ? (["open-directory-window"] as const) : []),
    ...(input.platform === "macos" ? (["reveal-in-finder"] as const) : []),
    "share",
  ];
}
