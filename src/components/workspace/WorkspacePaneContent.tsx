import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { BriefToasts } from "@/components/Toaster";
import { useWorkspaceRuntimeActive } from "./WorkspaceRuntimeContext";

/** The pane's own toast column, mounted only while the pane can be seen: a
 * background tab in a group and a pane on a warm or frozen desktop stay
 * mounted while hidden, and a column there would claim the pane's toasts
 * into a place nobody is looking (landing review 2026-09-13). Unmounted, the
 * claim is released and those toasts fall back to the workspace column. */
function PaneToastColumn({ api }: { api: IDockviewPanelProps["api"] }) {
	const [visible, setVisible] = useState(api.isVisible);
	useEffect(() => {
		setVisible(api.isVisible);
		const subscription = api.onDidVisibilityChange(({ isVisible }) =>
			setVisible(isVisible),
		);
		return () => subscription.dispose();
	}, [api]);
	const desktopActive = useWorkspaceRuntimeActive();
	if (!visible || !desktopActive) return null;
	return (
		<BriefToasts paneId={api.id} className="absolute inset-x-0 bottom-4" />
	);
}

/** Activate even panes whose content cannot focus (empty selectors, failed
 * connections). Capture runs before content can stop propagation; leave an
 * already-active pane mounted so WebKit can deliver the click. */
export function activateOnPointerDown<P extends IDockviewPanelProps>(
	Component: React.FunctionComponent<P>,
): React.FunctionComponent<P> {
	const Activatable = (props: P) => (
		<div
			className="relative h-full min-h-0 min-w-0"
			onPointerDownCapture={() => {
				// The clicked pane is already visible. Reopening it detaches its DOM
				// during pointerdown, cancelling WebKit's click and outside dismissal.
				if (!props.api.isActive) props.api.group.api.setActive();
			}}
		>
			<Component {...props} />
			{/* The pane's own toast column: a report made in this pane lands at
          this pane's bottom edge, not the workspace's. */}
			<PaneToastColumn api={props.api} />
		</div>
	);
	Activatable.displayName = `Activatable(${Component.displayName ?? Component.name ?? "Pane"})`;
	return Activatable;
}
