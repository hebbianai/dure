import type { IDockviewPanelProps } from "dockview-react";
import {
	ArrowLeft,
	ArrowRight,
	Crosshair,
	ExternalLink,
	Lock,
} from "lucide-react";
import { useEffect, useState } from "react";
import { isLoopbackUrl } from "@/components/design/DesignModeBrowserDialog";
import { ProBrowserPanel } from "@/components/panels/browser/ProBrowserPanel";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import { normalizeBrowserAddress as normalize } from "@/lib/browser/browserAddress";
import { openDesignModeBrowser } from "@/lib/design/designModeBrowser";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { showToast } from "@/lib/toast";
import { developmentPreviewsAvailable } from "@/lib/workspace/pane/interfaceMode";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";

export function BrowserPanel(props: IDockviewPanelProps<{ url: string }>) {
	const mode = useInterfaceMode();
	// The managed Browser needs a runtime that public bundles do not ship.
	return mode === "pro" && developmentPreviewsAvailable() ? (
		<ProBrowserPanel {...props} />
	) : (
		<BasicBrowserPanel {...props} />
	);
}

// iframe과 로드 전 placeholder가 같은 자리를 차지하도록 공유.
// bg-white는 토큰 누락이 아니다 — 여기 담기는 건 앱 크롬이 아니라 외부
// 웹 문서고, 웹의 기본 캔버스는 흰색이다. 앱 배경을 쓰면 다크 모드에서
// 흰 페이지가 그려지기 직전 한 프레임이 검게 번쩍인다.
const frameClass = "min-h-0 flex-1 border-0 bg-white";

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** 내부 브라우저 패널 (iframe 기반, 경량). AI 답변의 링크를 여기서 연다.
 *  자체 히스토리 스택으로 뒤/앞 이동(교차 오리진에서도 동작), reload는 리마운트. */
function BasicBrowserPanel(props: IDockviewPanelProps<{ url: string }>) {
	const start = normalize(props.params.url || "about:blank");
	const [history, setHistory] = useState<string[]>([start]);
	const [idx, setIdx] = useState(0);
	const [input, setInput] = useState(start);
	const [nonce, setNonce] = useState(0);
	const url = history[idx];
	// 숨은 탭·오프스크린 데스크탑에서 마운트만으로 페이지를 네트워크 로드하지
	// 않는다 — iframe 탑재는 pane이 실제로 보일 때(P0-c). 한 번 보이면 유지.
	const revealed = usePaneFirstReveal(props.api);

	useEffect(() => {
		applyAutomaticPaneTitle(props.api, hostOf(url));
		setInput(url);
	}, [url, props.api]);

	// 같은 패널에 다른 링크를 열면(dock.ts가 navigate 이벤트 발송) 그리로 이동
	useEffect(() => {
		const on = (e: Event) => {
			const to = (e as CustomEvent<string>).detail;
			go(normalize(to));
		};
		window.addEventListener(
			`browser-navigate:${props.api.id}`,
			on as EventListener,
		);
		return () =>
			window.removeEventListener(
				`browser-navigate:${props.api.id}`,
				on as EventListener,
			);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [history, idx]);

	const go = (to: string) => {
		if (to === url) {
			setNonce((n) => n + 1);
			return;
		}
		const next = history.slice(0, idx + 1);
		next.push(to);
		setHistory(next);
		setIdx(next.length - 1);
	};

	const submit = () => go(normalize(input));
	const back = () => idx > 0 && setIdx(idx - 1);
	const fwd = () => idx < history.length - 1 && setIdx(idx + 1);
	const reload = () => setNonce((n) => n + 1);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
				<IconButton
					disabled={idx === 0}
					onClick={back}
					title={t("common.back")}
				>
					<ArrowLeft className="size-3.5" />
				</IconButton>
				<IconButton
					disabled={idx >= history.length - 1}
					onClick={fwd}
					title={t("panels.browser.forward")}
				>
					<ArrowRight className="size-3.5" />
				</IconButton>
				<RefreshButton
					onClick={reload}
					title={t("common.refresh")}
					iconClassName="size-3.5"
				/>
				<div className="relative min-w-0 flex-1">
					{url.startsWith("https://") && (
						<Lock className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-status-run/70" />
					)}
					<Input
						className={url.startsWith("https://") ? "h-7 pl-7" : "h-7"}
						aria-label={t("panels.browser.address")}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
							if (e.key === "Escape") setInput(url);
						}}
						onFocus={(e) => e.target.select()}
						spellCheck={false}
					/>
				</div>
				{/* 요소 집기 — 이미 이 페이지를 보고 있는 자리에 둔다. 주소를 다시 입력할
            필요가 없다는 것이 이 위치의 요점이다(Design Mode B단계). iframe에서는
            크로스오리진 DOM에 닿을 수 없으므로 같은 URL을 별도 창으로 다시 연다. */}
				<IconButton
					disabled={!isLoopbackUrl(url)}
					title={
						isLoopbackUrl(url)
							? t("panels.browser.pickElementHint")
							: t("panels.browser.pickLocalhostOnly")
					}
					aria-label={t("panels.browser.pickElement")}
					onClick={() => {
						void openDesignModeBrowser(url).catch(() => {
							// 실패를 조용히 넘기지 않는다 — 눌렀는데 아무 일도 없으면 사용자는
							// 무엇이 잘못됐는지 알 수 없다.
							showToast(t("common.windowOpenFailed", { error: url }), {
								ms: 3000,
								paneId: props.api.id,
							});
						});
					}}
				>
					<Crosshair className="size-3.5" />
				</IconButton>
				<IconButton
					title={t("panels.browser.openExternal")}
					onClick={() => void openExternalUrl(url)}
				>
					<ExternalLink className="size-3.5" />
				</IconButton>
			</div>
			{revealed ? (
				<iframe
					key={`${url}#${nonce}`}
					src={url}
					className={frameClass}
					title="browser"
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
					referrerPolicy="no-referrer-when-downgrade"
				/>
			) : (
				<div className={frameClass} />
			)}
		</div>
	);
}
