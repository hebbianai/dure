import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	DURABLE_STORE_REHYDRATED_EVENT,
  GLASS_WINDOW_NATIVE_OPTIONS,
  nativeShellRadius,
	rehydrateDurableStore,
  rememberedMainDesktopId,
  rememberMainDesktopId,
  SECONDARY_WINDOW_LABEL_PREFIX,
} from "@/lib/workspace/window/windows";
import { SHELL_CORNER_RADIUS } from "@/lib/workspace/window/windowShellShape";
import { durableAppStorage, useStore } from "@/store";

interface Capability {
  windows?: string[];
  permissions?: (string | { identifier: string; allow?: { path?: string }[] })[];
}

const capability = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../src-tauri/capabilities/default.json", import.meta.url)),
    "utf8",
  ),
) as Capability;

/** A window whose label matches no capability gets zero core-plugin commands:
 *  no event listening (so no live terminal output), no clipboard, no dialogs.
 *  Renaming the label prefix without touching the glob silently breaks every
 *  secondary window, so the two are pinned together here. */
describe("secondary window capability", () => {
  const permissionIds = (capability.permissions ?? []).map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  const matches = (label: string) =>
    (capability.windows ?? []).some((pattern) =>
      new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(label),
    );

  it("covers the main window", () => {
    expect(matches("main")).toBe(true);
  });

  it("covers labels produced by openDesktopWindow", () => {
    expect(matches(`${SECONDARY_WINDOW_LABEL_PREFIX}1751234567890-0`)).toBe(true);
  });

  it("covers stable Agent session window labels", () => {
    expect(matches(`${SECONDARY_WINDOW_LABEL_PREFIX}session-agent-1`)).toBe(true);
  });

  it("grants webview-level focus so new windows accept keyboard input", () => {
    expect(permissionIds).toContain("core:webview:allow-set-webview-focus");
  });

  it("grants the local directory context-menu actions", () => {
    expect(permissionIds).toContain("opener:default");
    expect(permissionIds).toContain("opener:allow-open-path");
    const openPath = (capability.permissions ?? []).find(
      (permission) =>
        typeof permission !== "string" && permission.identifier === "opener:allow-open-path",
    );
    expect(typeof openPath === "string" ? undefined : openPath?.allow).toContainEqual({
      path: "$HOME/**",
    });
  });
});

describe("main desktop persistence naming", () => {
  it("writes the canonical Dure key and only reads the pre-rename key as fallback", () => {
    localStorage.clear();
    localStorage.setItem("hebbian-ide:last-main-desktop", "legacy-desktop");
    expect(rememberedMainDesktopId()).toBe("legacy-desktop");

    rememberMainDesktopId("canonical-desktop");
    expect(localStorage.getItem("dure:last-main-desktop")).toBe("canonical-desktop");
    expect(localStorage.getItem("hebbian-ide:last-main-desktop")).toBe("legacy-desktop");
    expect(rememberedMainDesktopId()).toBe("canonical-desktop");
  });
});

describe("durable store rehydration", () => {
	it("reconciles the durable adapter before hydrating Zustand", async () => {
		vi.stubGlobal("window", new EventTarget());
		const order: string[] = [];
		const reconcile = vi
			.spyOn(durableAppStorage, "reconcile")
			.mockImplementationOnce(async () => {
				order.push("reconcile");
			});
		const rehydrate = vi
			.spyOn(useStore.persist, "rehydrate")
			.mockImplementationOnce(async () => {
				order.push("hydrate");
			});
		try {
			await rehydrateDurableStore();
			expect(order).toEqual(["reconcile", "hydrate"]);
		} finally {
			reconcile.mockRestore();
			rehydrate.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it("emits the rehydrated event only after hydration succeeds", async () => {
		const failure = new Error("hydrate failed");
		vi.stubGlobal("window", new EventTarget());
		const rehydrate = vi
			.spyOn(useStore.persist, "rehydrate")
			.mockRejectedValueOnce(failure);
		const listener = vi.fn();
		window.addEventListener(DURABLE_STORE_REHYDRATED_EVENT, listener);
		try {
			await expect(rehydrateDurableStore()).rejects.toBe(failure);
			expect(listener).not.toHaveBeenCalled();

			rehydrate.mockResolvedValueOnce(undefined);
			await rehydrateDurableStore();
			expect(listener).toHaveBeenCalledOnce();
		} finally {
			window.removeEventListener(DURABLE_STORE_REHYDRATED_EVENT, listener);
			rehydrate.mockRestore();
			vi.unstubAllGlobals();
		}
	});
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MacWindowConfig {
  transparent?: boolean;
  acceptFirstMouse?: boolean;
  windowEffects?: { effects?: string[]; state?: string; radius?: number };
}

const macWindow = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../../src-tauri/tauri.macos.conf.json", import.meta.url)),
      "utf8",
    ),
  ) as { app?: { windows?: MacWindowConfig[] } }
).app?.windows?.[0];

/** 런타임 창은 메인 창과 같은 네이티브 옵션으로 열려야 한다. 한쪽만 바뀌면 그
 *  창만 다르게 보이는데, 눈으로 보기 전에는 아무도 모른다 — 실제로 모서리
 *  사각 자국이 두 번 돌아왔다. 두 곳을 여기서 묶어 둔다. */
describe("glass window native options", () => {
  it("웹뷰가 투명해야 그 뒤 effect view가 보인다", () => {
    expect(GLASS_WINDOW_NATIVE_OPTIONS.transparent).toBe(true);
  });

  it("effect 반경이 셸의 CSS 반경과 같다 — 어긋난 만큼 모서리에 쐐기가 생긴다", () => {
    expect(GLASS_WINDOW_NATIVE_OPTIONS.windowEffects.radius).toBe(SHELL_CORNER_RADIUS);
    expect(macWindow?.windowEffects?.radius).toBe(SHELL_CORNER_RADIUS);
  });

  /** material이 바뀌면 셸 유리의 톤이 통째로 달라진다 — 눈으로 보기 전에는
   *  드러나지 않으므로 측정으로 고른 값을 여기서 못 박는다. `sidebar`는 이름이
   *  그럴듯해 한 번 채택했다가 되돌렸다: 다크 외형에서 뒤를 통과시키지 않는다
   *  (2026-08-02 실측, windows.ts 주석). */
  it("셸 유리는 menu material을 쓴다", () => {
    expect(GLASS_WINDOW_NATIVE_OPTIONS.windowEffects.effects).toEqual(["menu"]);
  });

  /** CSS 반경만 떼면 전체화면에서 네이티브 반경이 남아 화면 네 귀퉁이가
   *  파인다 (사용자 보고 2026-08-01). */
  it("전체화면에서는 네이티브 모서리 반경을 0으로 편다", () => {
    expect(nativeShellRadius(true)).toBe(0);
    expect(nativeShellRadius(false)).toBe(SHELL_CORNER_RADIUS);
  });

  it("메인 창 설정과 런타임 창 설정이 같다", () => {
    expect(macWindow?.transparent).toBe(GLASS_WINDOW_NATIVE_OPTIONS.transparent);
    expect(macWindow?.windowEffects?.effects).toEqual([
      ...GLASS_WINDOW_NATIVE_OPTIONS.windowEffects.effects,
    ]);
    expect(macWindow?.windowEffects?.state).toBe(GLASS_WINDOW_NATIVE_OPTIONS.windowEffects.state);
  });

  it("비활성 macOS 창의 첫 클릭이 웹뷰까지 전달된다", () => {
    expect(macWindow?.acceptFirstMouse).toBe(true);
    expect(GLASS_WINDOW_NATIVE_OPTIONS.acceptFirstMouse).toBe(true);
  });
});
