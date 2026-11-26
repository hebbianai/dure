/** The Space's general Browser pane: one per Space and backend, navigated in
 * place when it is already open. Resource-bound browser views are not this
 * pane. */

import type { DockviewApi } from "dockview-react";
import {
	browserPaneBackendProfileId,
	readBrowserPanePurpose,
} from "@/lib/browser/browserPaneBinding";
import { t } from "@/lib/i18n";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

/** Open or navigate this workspace's general Browser view, not a resource
 * view. Without a backend profile it is the view that follows the selected
 * backend; with one, it is a view that runs on that backend. */
export function openBrowserPanelOn(
	api: DockviewApi,
	url: string,
	backendProfileId?: string,
) {
	const existing = api.panels.find((panel) => {
		const pane = dockPanelReference(panel);
		if (readBrowserPanePurpose(pane) !== "workspace") return false;
		return backendProfileId === undefined
			? pane.params.backendProfileId === undefined
			: browserPaneBackendProfileId(pane.params) === backendProfileId;
	});
	const panelId = existing?.id ?? createPaneId();
	openOrFocusPanel({
		api,
		panelId,
		component: "browser",
		title: t("workspace.paneKind.browser"),
		params:
			backendProfileId === undefined
				? { url, browserPurpose: "workspace" }
				: { url, browserPurpose: "workspace", backendProfileId },
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
