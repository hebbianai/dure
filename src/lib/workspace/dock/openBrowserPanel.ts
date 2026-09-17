/** The Space's general Browser pane: one per Space, navigated in place when
 * it is already open. Resource-bound browser views are not this pane. */

import type { DockviewApi } from "dockview-react";
import { readBrowserPanePurpose } from "@/lib/browser/browserPaneBinding";
import { t } from "@/lib/i18n";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

/** Open or navigate this workspace's general Browser view, not a resource view. */
export function openBrowserPanelOn(api: DockviewApi, url: string) {
	const existing = api.panels.find(
		(panel) =>
			readBrowserPanePurpose(dockPanelReference(panel)) === "workspace",
	);
	const panelId = existing?.id ?? createPaneId();
	openOrFocusPanel({
		api,
		panelId,
		component: "browser",
		title: t("workspace.paneKind.browser"),
		params: { url, browserPurpose: "workspace" },
		onExisting: () => {
			window.dispatchEvent(
				new CustomEvent(`browser-navigate:${panelId}`, { detail: url }),
			);
		},
	});
}

/** 데스크탑을 활성화하고 마운트를 기다렸다가 내부 브라우저를 연다.
 *  URL을 비우면 about:blank로 열려 주소창에서 직접 입력하게 된다. */
export function openBrowserPanelOnDesktop(desktopId: string, url = ""): void {
	withDesktopDockview(desktopId, (api) => {
		openBrowserPanelOn(api, url);
	});
}
