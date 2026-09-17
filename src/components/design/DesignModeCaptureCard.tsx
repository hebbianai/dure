// 캡처 직후의 대상 선택 카드 (Design Mode 슬라이스 2).
//
// 왜 즉시 보내지 않고 카드를 띄우나: 기본 대상이 "마지막으로 입력한 에이전트"라
// 근거가 약한 경우(최근 입력이 없거나 그 pane이 닫힌 경우)가 있고, 그때 조용히
// 첫 번째 pane으로 보내면 사용자는 엉뚱한 곳에 붙은 뒤에야 안다. 대상이 하나로
// 확실할 때는 카드가 곧바로 그것을 보여주므로 클릭 한 번이면 끝난다.
import { Clipboard, PenTool, Send, X } from "lucide-react";
import { useState } from "react";
import { FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ErrorText } from "@/components/ui/error-text";
import type { AgentTargetChoice } from "@/lib/design/designModeTarget";
import { t } from "@/lib/i18n";

export interface DesignModeCaptureCardProps {
	label: string;
	choice: AgentTargetChoice;
	imageSrc?: string;
	attachmentError?: boolean;
	busy?: boolean;
	onSend: (agentId: string, preset?: "raw" | "redesign-mockup") => void;
	onCopy: () => void;
	onDismiss: () => void;
}

export function DesignModeCaptureCard({
	label,
	choice,
	imageSrc,
	attachmentError,
	busy,
	onSend,
	onCopy,
	onDismiss,
}: DesignModeCaptureCardProps) {
	const [selected, setSelected] = useState(choice.defaultId ?? "");
	const hasTarget = choice.candidates.length > 0;

	// The update notice card's chrome, corner and title tier — the one floating
	// card the app has (owner call 2026-09-12; it was shadcn's popover, w-80,
	// 16px in from the corner while the update card sat 20px in, one layer
	// above). When both are up they still overlap; stacking them is a
	// follow-up.
	return (
		<div
			className={`fixed right-5 bottom-5 z-[100] w-[min(24rem,calc(100vw-2.5rem))] p-4 text-foreground ${FLOATING_CARD}`}
		>
			<div className="flex items-start gap-3">
				<p className="min-w-0 flex-1 truncate text-base font-semibold">
					{t("design.capture.title", { label })}
				</p>
				<IconButton
					title={t("common.close")}
					className="-my-1 -mr-1"
					disabled={busy}
					onClick={onDismiss}
				>
					<X />
				</IconButton>
			</div>

			{imageSrc && (
				<img
					src={imageSrc}
					alt={label}
					className="mt-2 max-h-40 w-full rounded object-contain"
				/>
			)}
			{attachmentError && (
				<ErrorText>{t("design.capture.imageUnavailable")}</ErrorText>
			)}
			{hasTarget ? (
				<>
					<p className="mt-2 text-xs text-muted-foreground">
						{choice.reason === "last_input"
							? t("design.capture.target.lastAgent")
							: choice.reason === "only_candidate"
								? t("design.capture.target.openAgent")
								: t("design.capture.target.noRecentConversation")}
					</p>
					{/* The app's Select, not a bare <select>: the card wears the
					    system's chrome outside and inside (owner, 2026-09-13). The
					    menu opens above the card's z-[100]. */}
					<Select value={selected} onValueChange={setSelected} disabled={busy}>
						<SelectTrigger
							className="mt-2 w-full"
							aria-label={t("common.sendToAgent")}
						>
							<SelectValue placeholder={t("common.sendToAgent")} />
						</SelectTrigger>
						<SelectContent className="z-[110]">
							{choice.candidates.map((candidate) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									{candidate.name} · {candidate.provider}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			) : (
				// 에이전트가 없다고 캡처를 버리지 않는다 — 클립보드로는 여전히 쓸 수 있다.
				<p className="mt-2 text-xs text-muted-foreground">
					{t("design.capture.target.noOpenAgent")}
				</p>
			)}

			<div className="mt-3 flex flex-wrap gap-2">
				{hasTarget && (
					<Button
						size="sm"
						disabled={!selected || busy}
						onClick={() => onSend(selected)}
					>
						<Send className="size-3.5" />
						{t("common.typeIntoPrompt")}
					</Button>
				)}
				{hasTarget && (
					<Button
						size="sm"
						variant="outline"
						disabled={!selected || busy}
						title={t("design.capture.redesignAsMockupHint")}
						onClick={() => onSend(selected, "redesign-mockup")}
					>
						<PenTool className="size-3.5" />
						{t("design.capture.redesignAsMockup")}
					</Button>
				)}
				<Button size="sm" variant="outline" onClick={onCopy} disabled={busy}>
					<Clipboard className="size-3.5" />
					{t(imageSrc ? "design.capture.copyText" : "common.copy")}
				</Button>
			</div>
			{hasTarget && (
				// 놀라지 않게 미리 말해 둔다 — 제출은 사용자가 한다.
				<p className="mt-2 text-xs text-muted-foreground opacity-70">
					{t("design.capture.insertOnlyHint")}
				</p>
			)}
		</div>
	);
}
