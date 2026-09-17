// 부팅 스모크 체크 — qa.ts에서 추출(god-file 다이어트).
// UI를 열지 않고 실제 백엔드 커맨드에 닿는지 확인해 qa.log에 남긴다.
// 유닛 테스트가 덮지 못하는 "실기에서 배선이 살아 있는가"를 매 부팅마다 본다.

/** qa.ts의 로거 시그니처. */
type QaLog = (kind: string, payload: unknown) => void;

export async function runBootSmokeChecks(qaLog: QaLog): Promise<void> {
  const results: Record<string, string> = {};
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const v = await fn();
      results[name] = `OK ${JSON.stringify(v)?.slice(0, 120)}`;
    } catch (e) {
      results[name] = `FAIL ${String(e)}`;
    }
  };

  const ipc = await import("@/lib/ipc");
  await check("home_dir", () => ipc.homeDir());
  await check("usage_recent", async () => {
    const u = await ipc.usageRecent(24);
    return `CL=${u.claude.total} CX=${u.codex.total} CX%=${u.codex.usedPercent}`;
  });
  await check("app_compatibility", () => ipc.appCompatibility(true));
  await check("git_status(/tmp)", () => ipc.gitStatus("/tmp"));
  await check("list_dir(home)", async () => {
    const entries = await ipc.listDir(await ipc.homeDir());
    return `${entries.length} entries`;
  });
  // 설정 창이 쓰는 새 커맨드 — UI를 열지 않고 배선만 확인한다. 유닛 테스트는
  // 프론트 로직만 덮고 이 둘은 실제 macOS API를 타므로 실기에서 한 번은 봐야 한다.
  await check("system_font_families", async () => {
    const fonts = await ipc.systemFontFamilies();
    return `${fonts.length} families, ${fonts.filter((f) => f.monospaced).length} mono`;
  });
  // null은 "아직 안 물어봄"이라 정상값이다 — 키가 다 오는지만 본다.
  await check("macos_permissions", async () => Object.keys(await ipc.macosPermissions()).join(","));

  // dialog plugin reachability *without* opening UI: an invalid subcommand
  // returns a "not found" error, a missing permission returns "not allowed"
  await check("dialog-plugin", () => ipc.dialogPluginProbe());

  qaLog("smoke", results);
}
