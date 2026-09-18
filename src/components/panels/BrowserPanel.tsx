import type { IDockviewPanelProps } from "dockview-react";
import { ProBrowserPanel } from "@/components/panels/browser/ProBrowserPanel";

export function BrowserPanel(props: IDockviewPanelProps<{ url: string }>) {
	return <ProBrowserPanel {...props} />;
}
