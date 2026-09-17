// 창 chrome의 Pinpoint 진입 — 요소를 짚어 에이전트에 보내는 모드.
//
// 왜 pane 헤더가 아니라 창 chrome인가: Pinpoint는 pane에도 에이전트에도 매여
// 있지 않다. 짚는 것이 먼저이고, 어느 에이전트로 보낼지는 캡처 카드에서
// *그 다음에* 고른다. pane 헤더에 두면 "이 pane에 대해 짚는다"로 읽혀 순서가
// 거꾸로 보인다(사용자 지적 2026-07-31). 창 chrome은 앱 전역 표면이라 이
// 모드의 범위와 일치하고, 항상 보이므로 단축키를 모르는 사람도 찾는다.
import { Crosshair } from "lucide-react";
import { useEffect, useState } from "react";
import { DesignModeBrowserDialog } from "@/components/design/DesignModeBrowserDialog";
import { IconButton } from "@/components/ui/icon-button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openDesignModeBrowser } from "@/lib/design/designModeBrowser";
import { toggleDesignMode } from "@/lib/design/designModeRuntime";
import { t } from "@/lib/i18n";
import {
	type PinpointActionId,
	pinpointActions,
	pinpointIsDirect,
} from "@/lib/design/pinpointActions";
import { showToast } from "@/lib/toast";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";

export function PinpointButton() {
	const dev = import.meta.env.DEV;
	// 기본 모드 간소화(2026-08-31): 짚어 보내기는 pro 워크플로 — 버튼·⌥⇧B
	// 단축키·다이얼로그가 한 소유자라 함께 접힌다.
	const interfaceMode = useInterfaceMode();
	const basic = interfaceMode === "basic";
	const actions = pinpointActions(dev);
	const [browserOpen, setBrowserOpen] = useState(false);

	const run = (id: PinpointActionId) => {
		if (id === "self") {
			void toggleDesignMode();
			return;
		}
		setBrowserOpen(true);
	};

	// ⌥⇧B — 주소 입력. 다이얼로그를 이 컴포넌트가 소유하므로 단축키도 여기 둔다
	// (소유자가 둘이면 어느 쪽이 열렸는지 알 수 없다).
	useEffect(() => {
		if (basic) return;
		const onKey = (event: KeyboardEvent) => {
			if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey)
				return;
			if (event.code !== "KeyB") return;
			event.preventDefault();
			setBrowserOpen(true);
		};
		// 캡처 단계 — 터미널(xterm)이 키를 먼저 삼키기 전에 가로챈다.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [basic]);

	const dialog = (
		<DesignModeBrowserDialog
			open={browserOpen}
			onOpenChange={setBrowserOpen}
			onSubmit={(url) => {
				void openDesignModeBrowser(url)
					.then(() => {
						showToast(t("design.pinpoint.windowOpened"), 2600);
					})
					.catch((error) => {
						// 조용히 실패하면 사용자는 창이 왜 안 뜨는지 알 수 없다.
						showToast(
							t("common.windowOpenFailed", { error: String(error) }),
							3200,
						);
					});
			}}
		/>
	);

	const label = t("design.pinpoint.buttonLabel");

	if (basic) return null;

	if (pinpointIsDirect(dev)) {
		return (
			<>
				<IconButton
					title={`${label} (${actions[0].shortcut})`}
					className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
					onClick={() => run(actions[0].id)}
				>
					<Crosshair />
				</IconButton>
				{dialog}
			</>
		);
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<IconButton
						title={label}
						className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
					>
						<Crosshair />
					</IconButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-60">
					{actions.map((action) => (
						<DropdownMenuItem key={action.id} onSelect={() => run(action.id)}>
							<span className="min-w-0 flex-1 truncate text-xs">
								{t(action.label)}
							</span>
							{/* 키캡을 같이 보여 준다 — 메뉴가 단축키를 가르치는 자리다 */}
							<span className="shrink-0 text-[10px] text-muted-foreground">
								{action.shortcut}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog}
		</>
	);
}
