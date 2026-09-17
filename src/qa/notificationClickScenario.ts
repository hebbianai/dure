import type {
	NotificationClickQaPresentation,
	NotificationClickQaScenario,
} from "@/lib/ipc/notifications";

export type {
	NotificationClickQaPresentation,
	NotificationClickQaScenario,
} from "@/lib/ipc/notifications";

export interface NotificationClickQaPlan {
	presentation: NotificationClickQaPresentation;
	exitBeforeClick: boolean;
	targetWindow: boolean;
}

export function notificationClickQaPlan(
	scenario: NotificationClickQaScenario,
): NotificationClickQaPlan {
	switch (scenario) {
		case "cold-start":
			return {
				presentation: "terminating",
				exitBeforeClick: true,
				targetWindow: false,
			};
		case "minimized":
			return {
				presentation: "minimized",
				exitBeforeClick: false,
				targetWindow: false,
			};
		case "multi-window":
			return {
				presentation: "hidden",
				exitBeforeClick: false,
				targetWindow: true,
			};
		case "owner-change":
			return {
				presentation: "hidden",
				exitBeforeClick: false,
				targetWindow: false,
			};
	}
}

export function notificationClickQaLayout(panelId: string): unknown {
	return { panels: { [panelId]: { params: {} } } };
}
