import { DureMark } from "@/components/common/DureMark";
import { t } from "@/lib/i18n";

/** 첫 실행 화면들의 공통 도입부 — 마크·제목·설명, 그리고 화면이 조작 힌트를
 *  가질 때만 그 아래 한 줄. 세션 가져오기와 폴더로 시작하기가 같이 쓴다. */
export function OnboardingHero({
	title,
	description,
	paneLimit,
}: {
	title: string;
	description: string;
	/** 주면 "행을 끌어 스페이스 이동 · N-pane 권장" 힌트 줄을 그린다. */
	paneLimit?: number;
}) {
	return (
		<div className="flex w-full min-w-[272px] flex-col items-center gap-5">
			<div className="flex flex-col items-center gap-6">
				<DureMark className="h-[38px] w-9 text-foreground" />
				<div className="flex flex-col items-center gap-1.5 text-center">
					<h2 className="text-2xl/8 font-medium text-foreground">{title}</h2>
					<p className="text-[13px]/4 text-muted-foreground">{description}</p>
				</div>
			</div>
			{paneLimit !== undefined && (
				<p className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
					<span>{t("onboarding.import.hint.dragRows")}</span>
					<span aria-hidden className="h-3 w-px bg-border" />
					<span>{t("onboarding.import.hint.paneRecommended", { n: paneLimit })}</span>
				</p>
			)}
		</div>
	);
}
