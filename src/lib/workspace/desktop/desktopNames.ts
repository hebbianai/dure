import type { Space } from "@/types";

export const DEFAULT_SPACE: Space = { id: "desk-1", name: "Main" };

export function migrateLegacyDesktopName(name: string): string {
  const match = /^Desktop (\d+)$/.exec(name);
  if (!match) return name;
  const legacyIndex = Number(match[1]);
  if (legacyIndex <= 1) return "Main";
  if (legacyIndex === 2) return "Workspace";
  return `Workspace ${legacyIndex - 1}`;
}

export function nextSpaceName(spaces: readonly Pick<Space, "name">[]): string {
  const names = new Set(spaces.map((desktop) => desktop.name));
  if (!names.has("Workspace")) return "Workspace";
  for (let index = 2; ; index += 1) {
    const candidate = `Workspace ${index}`;
    if (!names.has(candidate)) return candidate;
  }
}
