export type DesktopPlatform = "macos" | "linux" | "windows" | "unknown";

export function detectDesktopPlatform(
  identity = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
): DesktopPlatform {
  const normalized = identity.toLowerCase();
  if (/mac|iphone|ipad/.test(normalized)) return "macos";
  if (/linux|x11/.test(normalized)) return "linux";
  if (/win/.test(normalized)) return "windows";
  return "unknown";
}

export function isMacPlatform(identity?: string): boolean {
  return detectDesktopPlatform(identity) === "macos";
}
