import { afterEach, describe, expect, it, vi } from "vitest";
import { hmux } from "@/lib/ipc";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import {
	executeHmuxSessionConversion,
	type HmuxSessionConversionInspection,
} from "./hmuxSessionConversion";

afterEach(() => vi.restoreAllMocks());

describe("conversion launch colors", () => {
	it.each(["managed", "standalone"] as const)(
		"passes the current theme to a %s conversion before attachment",
		async (target) => {
			const convert = vi.spyOn(hmux, "convertSession").mockResolvedValue({
				sourceSessionId: "source",
				sourceWorkspaceId: "workspace",
				targetClass: target,
				action:
					target === "managed"
						? "convert_standalone_to_managed_with_exact_conversation"
						: "convert_managed_to_standalone_with_exact_conversation",
				outcome: "refused",
				replayed: false,
				requiresConfirmation: true,
				providerId: "codex",
			});
			const inspection: HmuxSessionConversionInspection = {
				desktopId: "desktop",
				panelId: "term:source",
				resolvedPanelId: "term:source",
				sourceBinding:
					target === "managed"
						? hmuxStandaloneBinding("source", "workspace")
						: hmuxManagedBinding("source", "workspace"),
				target,
				providerId: "codex",
				cwd: "/repo",
				conversionId: "conversion",
				permissionMode: "default",
				terminalEnvironment: {},
			};
			const original = useStore.getState();
			try {
				for (const [theme, colors] of [
					["light", { foregroundRgb: 0x171717, backgroundRgb: 0xffffff }],
					["dark", { foregroundRgb: 0xe5e5e5, backgroundRgb: 0x242424 }],
				] as const) {
					useStore.setState({
						uiPrefs: { ...original.uiPrefs, theme, themeScheme: undefined },
					});
					await executeHmuxSessionConversion(inspection, true);
					expect(convert).toHaveBeenLastCalledWith(
						expect.objectContaining({
							conversionId: inspection.conversionId,
							target,
							terminalDefaultColors: colors,
						}),
					);
				}
			} finally {
				useStore.setState({ uiPrefs: original.uiPrefs });
			}
		},
	);
});
