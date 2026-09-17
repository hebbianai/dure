import { LoadingStatus } from "@/components/common/PanelStatus";
import type { IDockviewPanelProps } from "dockview-react";
import { lazy, type ReactNode, Suspense } from "react";
import type { FileViewerParams } from "@/components/files/FileViewerPanel";
import type {
	GitHubIssuePanelParams,
	GitHubWorkspacePanelParams,
} from "@/components/github/GitHubWorkspacePanel";
import type { MockupPanelParams } from "@/components/panels/MockupPanel";
import type { DiffReviewPanelParams } from "@/lib/scm/review/diffReviewTarget";

const MobileSimulatorPanel = lazy(() =>
	import("@/components/panels/mobile/MobileSimulatorPanel").then((module) => ({
		default: module.MobileSimulatorPanel,
	})),
);

const BrowserPanel = lazy(() =>
	import("@/components/panels/BrowserPanel").then((module) => ({
		default: module.BrowserPanel,
	})),
);
const DiffPanel = lazy(() =>
	import("@/components/scm/DiffPanel").then((module) => ({
		default: module.DiffPanel,
	})),
);
const FileViewerPanel = lazy(() =>
	import("@/components/files/FileViewerPanel").then((module) => ({
		default: module.FileViewerPanel,
	})),
);
const GitPanel = lazy(() =>
	import("@/components/panels/GitPanel").then((module) => ({
		default: module.GitPanel,
	})),
);
const GitHubWorkspacePanel = lazy(() =>
	import("@/components/github/GitHubWorkspacePanel").then((module) => ({
		default: module.GitHubWorkspacePanel,
	})),
);
const MockupPanel = lazy(() =>
	import("@/components/panels/MockupPanel").then((module) => ({
		default: module.MockupPanel,
	})),
);
const TokenInspectorPanel = lazy(() =>
	import("@/components/panels/TokenInspectorPanel").then((module) => ({
		default: module.TokenInspectorPanel,
	})),
);
const OnboardingPanel = lazy(() =>
	import("@/components/panels/OnboardingPanel").then((module) => ({
		default: module.OnboardingPanel,
	})),
);

function PanelLoader({ children }: { children: ReactNode }) {
	return (
		<Suspense
			fallback={
				<LoadingStatus size="sm" className="bg-background" />
			}
		>
			{children}
		</Suspense>
	);
}

export function LazyBrowserPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<BrowserPanel {...(props as IDockviewPanelProps<{ url: string }>)} />
		</PanelLoader>
	);
}

export function LazyDiffPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<DiffPanel {...(props as IDockviewPanelProps<DiffReviewPanelParams>)} />
		</PanelLoader>
	);
}

export function LazyFileViewerPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<FileViewerPanel {...(props as IDockviewPanelProps<FileViewerParams>)} />
		</PanelLoader>
	);
}

export function LazyGitPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<GitPanel {...(props as IDockviewPanelProps<{ projectId: string }>)} />
		</PanelLoader>
	);
}

const GitHubIssuePanel = lazy(() =>
	import("@/components/github/GitHubWorkspacePanel").then((module) => ({
		default: module.GitHubIssuePanel,
	})),
);

export function LazyGitHubIssuePanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<GitHubIssuePanel
				{...(props as IDockviewPanelProps<GitHubIssuePanelParams>)}
			/>
		</PanelLoader>
	);
}

export function LazyGitHubWorkspacePanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<GitHubWorkspacePanel
				{...(props as IDockviewPanelProps<GitHubWorkspacePanelParams>)}
			/>
		</PanelLoader>
	);
}

export function LazyMockupPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<MockupPanel {...(props as IDockviewPanelProps<MockupPanelParams>)} />
		</PanelLoader>
	);
}

export function LazyTokenInspectorPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<TokenInspectorPanel {...props} />
		</PanelLoader>
	);
}

export function LazyOnboardingPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<OnboardingPanel {...props} />
		</PanelLoader>
	);
}

export function LazyMobileSimulatorPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<MobileSimulatorPanel {...props} />
		</PanelLoader>
	);
}

const SharedConversationPanel = lazy(() =>
	import("@/components/agents/chat/SharedConversationPanel").then((module) => ({
		default: module.SharedConversationPanel,
	})),
);
export function LazySharedConversationPanelLoader(props: IDockviewPanelProps) {
	return (
		<PanelLoader>
			<SharedConversationPanel {...props} />
		</PanelLoader>
	);
}
