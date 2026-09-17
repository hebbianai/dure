// 관리형 에이전트 검사 결과의 순수 데이터 계약 — leaf 모듈.
//
// managedAgentRehostInspection.ts에서 분리(2026-08-01 순환 절단). 그 파일은
// useStore·providers·dock을 런타임 임포트하는데, persistence 백본
// (persistedAgents → deferredCredentialSwitch)이 이 타입 하나 때문에 그
// 파일을 임포트하면서 store를 도는 순환 36개가 생겼다. 계약만 leaf로 내리면
// 백본의 임포트 폐포가 leaf-only가 된다.

import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { AccountProfile, Provider, TerminalEnvironment } from "@/types";

export interface ManagedAgentCredentialSwitchInspection {
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	sourceBinding: HmuxManagedPaneBindingV1;
	/** Presentation hint only; never replacement authority. */
	sourcePaneState?: "present" | "absent";
	sourceCredentialId?: string;
	sourceConversationId?: string;
	targetCredentialId: string | null;
	/** Transient preflight fence only; never included in the sync payload. */
	targetAccount?: AccountProfile;
	conversationId: string;
	cwd: string;
	desktopId: string;
	panelId: string;
	permissionMode: "default" | "bypass_approvals";
	terminalEnvironment: TerminalEnvironment;
}
