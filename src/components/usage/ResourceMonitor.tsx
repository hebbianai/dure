// 상단 바 자원 위젯 — CPU·메모리·세션 수·워크스페이스 볼륨 여유.
//
// Pro에서 설정(외관 > 상태 표시줄 > 자원 관리자)으로 켜고 끈다. 기본은 꺼짐.
// 렌더하지 않을 때는 폴링도 시작하지 않는다 — 안 보이는 사람에게는
// 주기적인 표본 하나도 돌지 않아야 한다.
//
// 숫자는 곁눈으로 읽는 자리라 요약만 두고, 전체 값(메모리 총량·디스크 총량)은
// 호버 title로 미룬다. 표시 규칙은 순수 모듈 systemResources가 소유한다.
import { Cpu, HardDrive, Layers, MemoryStick } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { systemResources } from "@/lib/ipc";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import {
	describeResources,
	formatDiskFree,
	formatMemory,
	formatPercent,
	type SystemResources,
} from "@/lib/usage/systemResources";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { Button } from "@/components/ui/button";
import { AgentCleanupDiagnostics } from "./AgentCleanupDiagnostics";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

/** 표본 간격. CPU는 두 표본의 차이라 너무 촘촘하면 노이즈만 늘고, 너무
 *  느리면 "지금 무거운가"에 답하지 못한다. */
const SAMPLE_INTERVAL_MS = 4000;

export function ResourceMonitor() {
	const interfaceMode = useInterfaceMode();
	const enabled =
		useStore(
			(state) =>
				state.uiPrefs.showResourceMonitor ??
				DEFAULT_UI_PREFS.showResourceMonitor,
		) && interfaceMode === "pro";
	const sessions = useStore((state) => state.agents.length);
	// 디스크는 어느 볼륨인지 정해야 잴 수 있다 — 첫 프로젝트 경로를 기준으로
	// 삼는다. 프로젝트가 없으면 디스크 항목 없이 CPU·메모리만 보인다.
	const workspacePath = useStore((state) => state.projects[0]?.path);
	const [sample, setSample] = useState<SystemResources | null>(null);

	useEffect(() => {
		if (!enabled) {
			setSample(null);
			return;
		}
		let alive = true;
		const read = () => {
			systemResources(workspacePath)
				.then((next) => {
					if (alive) setSample(next);
				})
				// 표본 하나가 실패해도 위젯을 지우지 않는다 — 다음 주기가 다시 읽는다.
				.catch(() => {});
		};
		read();
		const timer = setMaintenanceLaneInterval(
			read,
			SAMPLE_INTERVAL_MS,
			"resource-monitor",
		);
		return () => {
			alive = false;
			clearMaintenanceLaneInterval(timer);
		};
	}, [enabled, workspacePath]);

	if (!enabled || !sample) return null;

	const diskFree = formatDiskFree(sample);
	const description = describeResources(sample, sessions, {
		cpu: t("CPU"),
		memory: t("usage.resources.memory"),
		sessions: t("common.session"),
		disk: t("usage.resources.disk"),
	});
	const metrics = [
		{ label: t("CPU"), icon: Cpu, value: formatPercent(sample.cpuPercent) },
		{
			label: t("usage.resources.memory"),
			icon: MemoryStick,
			value: formatMemory(sample),
		},
		{ label: t("common.session"), icon: Layers, value: String(sessions) },
		...(diskFree === null
			? []
			: [
					{
						label: t("usage.resources.disk"),
						icon: HardDrive,
						value: diskFree,
					},
				]),
	];
	return (
		<AgentCleanupDiagnostics>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={t("usage.cleanup.title")}
				aria-description={description}
				title={`${t("usage.cleanup.title")}\n${description}`}
				className="gap-3 px-2 font-normal text-muted-foreground"
			>
				{metrics.map(({ label, icon: Icon, value }) => (
					<span key={label} className="inline-flex items-center gap-1.5">
						<Icon className="size-3" aria-hidden="true" />
						<span className="sr-only">{label} </span>
						<span className="font-mono text-meta tabular-nums">{value}</span>
					</span>
				))}
			</Button>
		</AgentCleanupDiagnostics>
	);
}
