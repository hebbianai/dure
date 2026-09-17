import { FileText, GitBranch, Globe, Server, Terminal } from "lucide-react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { GithubRailIcon } from "@/components/sidebar/RailIcons";
import type { Provider } from "@/types";

export function PaneChromeIcon({
	component,
	nestedSsh,
	agentProvider,
	terminalProvider,
}: {
	component: string;
	nestedSsh: boolean;
	/** Agent panes normally go through AgentActivityGlyph (logo, loader while
	 * working, state badge); this is the plain logo for callers without a
	 * display state. */
	agentProvider?: Provider;
	terminalProvider?: Provider | null;
}) {
	if (nestedSsh) {
		return (
			<PaneIconSlot>
				<Server />
			</PaneIconSlot>
		);
	}
	if (agentProvider) {
		return (
			<ProviderGlyph provider={agentProvider} className="size-3 text-inherit" />
		);
	}
	if (terminalProvider) {
		return (
			<ProviderGlyph
				provider={terminalProvider}
				className="size-3 text-inherit"
			/>
		);
	}
	if (component === "github") {
		return (
			<PaneIconSlot>
				<GithubRailIcon />
			</PaneIconSlot>
		);
	}
	const Icon =
		component === "terminal"
			? Terminal
			: component === "ssh"
				? Server
				: component === "git"
					? GitBranch
					: component === "browser"
						? Globe
						: component === "fileviewer"
							? FileText
							: undefined;
	return Icon ? (
		<PaneIconSlot>
			<Icon />
		</PaneIconSlot>
	) : null;
}

/** Optical correction: a 16px Lucide glyph fills the design's 12px icon slot.
 *
 *  PaneChrome supplies the shared title and glyph tone: foreground when
 *  focused, muted otherwise. */
function PaneIconSlot({ children }: { children: React.ReactNode }) {
	return (
		<span className="flex size-3 shrink-0 items-center justify-center [&_svg]:size-4">
			{children}
		</span>
	);
}
