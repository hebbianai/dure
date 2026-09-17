import type { IDockviewPanelProps } from "dockview-react";
import { MessageSquarePlus, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmationButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { LoadingStatus, PanelStatus } from "@/components/common/PanelStatus";
import { Textarea } from "@/components/ui/textarea";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import { typeAgentPrompt } from "@/lib/agents/agentDelivery";
import {
	appCssSources,
	buildMockupSrcdoc,
	mockupPaneTitle,
} from "@/lib/design/mockupSrcdoc";
import { describeMockupElement, formatMockupComment } from "@/lib/design/mockupReview";
import { t } from "@/lib/i18n";
import { readFile } from "@/lib/ipc/files";
import { schemeOverrideCss } from "@/lib/theme/themePreference";
import { showErrorToast, showToast } from "@/lib/toast";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import { usePaneAgentChoices } from "./usePaneAgentChoices";

export interface MockupPanelParams {
	/** repo-local mockup path: design/mockups/<cluster>/<Name>/<state>.html */
	path: string;
}

/** Full CSS text the parent document actually loaded (inline styles + fetched
 *  stylesheet links) — minus the live theme override, which is replaced by the
 *  previewed appearance's scheme override. */
async function collectAppCss(previewDark: boolean): Promise<string> {
	const sources = appCssSources(document);
	const fetched = await Promise.all(
		sources.hrefs.map(async (href) => {
			try {
				return await (await fetch(href)).text();
			} catch {
				return ""; // one dead stylesheet must not blank the whole preview
			}
		}),
	);
	return [...sources.inline, ...fetched, schemeOverrideCss(previewDark)].join("\n");
}

interface MockupBuild {
	srcdoc: string;
	dark: boolean;
	nonce: number;
}

/** Renders design/mockups HTML using mockupSrcdoc and the previewed theme. */
export function MockupPanel(props: IDockviewPanelProps<MockupPanelParams>) {
	const { path } = props.params;
	// One atomic generation: the iframe key and srcDoc always come from the
	// same completed build, so a toggle can never remount with stale content.
	const [build, setBuild] = useState<MockupBuild | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [dark, setDark] = useState(() =>
		document.documentElement.classList.contains("dark"),
	);
	const [nonce, setNonce] = useState(0);
	const agents = usePaneAgentChoices();
	/** review comment draft (anchor picked from the rendered mockup) */
	const [draft, setDraft] = useState<{ anchor: string; comment: string; agentId: string } | null>(
		null,
	);
	const [commentMode, setCommentMode] = useState(false);
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	// A hidden tab must not read anything on mount — load on first reveal.
	const revealed = usePaneFirstReveal(props.api);

	// Agents whose worktree contains this mockup — a repo-relative path in the
	// prompt resolves against the AGENT's cwd, so a cross-worktree default
	// would silently edit another checkout's copy.
	const matchingAgents = agents.filter(
		(agent) =>
			agent.worktreePath &&
			(path === agent.worktreePath || path.startsWith(`${agent.worktreePath}/`)),
	);
	const orderedAgents = [
		...matchingAgents,
		...agents.filter((agent) => !matchingAgents.includes(agent)),
	];

	const pickElementAt = (clientX: number, clientY: number) => {
		const doc = frameRef.current?.contentDocument;
		const rect = frameRef.current?.getBoundingClientRect();
		if (!doc || !rect) return;
		let x = clientX - rect.left;
		let y = clientY - rect.top;
		// Keyboard activation synthesizes a click at (0,0) — outside the frame.
		// Clamp to the frame center so the affordance stays operable.
		if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
			x = rect.width / 2;
			y = rect.height / 2;
		}
		const el = doc.elementFromPoint(x, y);
		if (!el) return;
		setCommentMode(false);
		setDraft({
			anchor: describeMockupElement(el),
			comment: "",
			agentId: (matchingAgents[0] ?? agents[0])?.id ?? "",
		});
	};

	// Reconcile a stale draft target against the live agent list at render time.
	const effectiveAgentId =
		draft && agents.some((agent) => agent.id === draft.agentId)
			? draft.agentId
			: ((matchingAgents[0] ?? agents[0])?.id ?? "");

	const sendComment = async () => {
		if (!draft) return;
		const agent = agents.find((candidate) => candidate.id === effectiveAgentId);
		if (!agent) {
			showErrorToast(t("panels.mockup.noAgentsOpen"), { paneId: props.api.id });
			return;
		}
		// The pane may hold an absolute path — the agent needs the repo-relative one.
		const relPath = path.replace(/^.*?(design\/mockups\/)/, "$1");
		try {
			// Type-only, never auto-submitted — same trust rule as DesignMode
			// capture: the user reviews the prompt and presses Enter.
			await typeAgentPrompt(
				agent,
				formatMockupComment({ path: relPath, anchor: draft.anchor, comment: draft.comment }),
			);
			setDraft(null);
			showToast(t("common.typedIntoPromptPressEnter"), { ms: 3000, paneId: props.api.id });
		} catch (cause) {
			showErrorToast(t("common.typeFailed", { error: String(cause) }), { paneId: props.api.id });
		}
	};

	useEffect(() => {
		applyAutomaticPaneTitle(props.api, mockupPaneTitle(path) ?? path);
	}, [path, props.api]);

	useEffect(() => {
		if (!revealed) return;
		let cancelled = false;
		(async () => {
			setError(null);
			try {
				const [file, appCss] = await Promise.all([
					readFile(path),
					collectAppCss(dark),
				]);
				if (cancelled) return;
				if (file.kind !== "text" && file.kind !== "markdown") {
					setError(t("panels.mockup.notHtmlMockup"));
					return;
				}
				setBuild({ srcdoc: buildMockupSrcdoc(file.content, appCss, dark), dark, nonce });
			} catch (cause) {
				if (!cancelled) setError(String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, dark, revealed, nonce]);

	return (
		<div data-pane-surface="own" className="flex h-full min-h-0 flex-col bg-surface-background">
			<div className="flex items-center gap-1 border-b border-border px-2 py-1">
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
					{path.split("/").slice(-3).join("/")}
				</span>
				<IconButton
					title={dark ? t("panels.mockup.previewLight") : t("panels.mockup.previewDark")}
					onClick={() => setDark((v) => !v)}
				>
					{dark ? <Sun /> : <Moon />}
				</IconButton>
				<IconButton
					title={t("panels.mockup.pickElementHint")}
					pressed={commentMode}
					onClick={() => {
						setDraft(null);
						setCommentMode((v) => !v);
					}}
				>
					<MessageSquarePlus />
				</IconButton>
				<RefreshButton
					title={t("panels.mockup.reload")}
					onClick={() => setNonce((n) => n + 1)}
				/>
			</div>
			{draft ? (
				<div className="flex flex-col gap-2 border-b border-border px-3 py-2">
					<span className="font-mono text-[11px] text-muted-foreground">{draft.anchor}</span>
					<Textarea
						className="min-h-14 text-xs"
						placeholder={t("panels.mockup.changePrompt")}
						value={draft.comment}
						onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
					/>
					<div className="flex items-center gap-2">
						<div className="min-w-0 flex-1">
						<SelectField
							aria-label={t("common.sendToAgent")}
							value={effectiveAgentId}
							onValueChange={(nextValue) => setDraft({ ...draft, agentId: nextValue })}
						>
							{orderedAgents.map((agent) => (
								<SelectOption key={agent.id} value={agent.id}>
									{agent.name} · {agent.provider}
									{matchingAgents.includes(agent)
										? ` · ${t("panels.mockup.thisWorktree")}`
										: ""}
								</SelectOption>
							))}
						</SelectField>
						</div>
						<ConfirmationButton
							type="button"
							variant="glass"
							onClick={() => setDraft(null)}
						>
							{t("common.cancel")}
						</ConfirmationButton>
						<ConfirmationButton
							type="button"
							disabled={!draft.comment.trim() || !effectiveAgentId}
							onClick={() => void sendComment()}
						>
							{t("common.typeIntoPrompt")}
						</ConfirmationButton>
					</div>
					{effectiveAgentId &&
					matchingAgents.length > 0 &&
					!matchingAgents.some((agent) => agent.id === effectiveAgentId) ? (
						<span className="text-[10px] text-muted-foreground">
							{t("panels.mockup.agentMissingMockup")}
						</span>
					) : null}
				</div>
			) : null}
			{error ? (
				<PanelStatus className="h-auto flex-1 p-4">
					{t("panels.mockup.openFailed")}: {error}
				</PanelStatus>
			) : build === null ? (
				<LoadingStatus size="sm" className="h-auto flex-1 p-4" />
			) : (
				<div className="relative min-h-0 flex-1">
					<iframe
						ref={frameRef}
						key={`${build.dark}:${build.nonce}`}
						title={mockupPaneTitle(path) ?? path}
						// Mockups are static HTML — sandbox without allow-scripts blocks
						// scripts; allow-same-origin keeps the parent's theme access only.
						sandbox="allow-same-origin"
						className="h-full w-full border-0 bg-background"
						srcDoc={build.srcdoc}
					/>
					{commentMode ? (
						// Click-capture overlay: the sandboxed doc runs no scripts, so
						// element picking happens from the parent via elementFromPoint.
						<button
							type="button"
							aria-label={t("panels.mockup.pickElementToComment")}
							className="absolute inset-0 h-full w-full cursor-crosshair border-0 bg-transparent p-0"
							onClick={(e) => pickElementAt(e.clientX, e.clientY)}
						/>
					) : null}
				</div>
			)}
		</div>
	);
}
