// provider가 "무엇을 할 수 있는가"를 매니페스트에서 읽어 표로 만든다 —
// 설정 › 프로바이더 페이지의 순수 로직.
//
// 이 모듈이 존재하는 이유: 예전 프로바이더 페이지는 계정 분리를 지원하는 셋만
// 싣고, 그 셋에 대해서만 손으로 적은 행을 그렸다. 그래서 설치해 둔 나머지
// CLI는 "이 앱이 이 CLI로 무엇을 할 수 있는지" 물어볼 곳이 아예 없었다.
// 능력은 이미 ProviderSpec에 선언돼 있으므로 화면이 그 선언을 읽게 하면
// provider가 늘어도 페이지를 고칠 필요가 없다 — 새 provider는 매니페스트에만
// 추가된다.

import { PROVIDERS, type Provider, type ProviderSpec } from "@/types";

export type ProviderCapabilityKey =
	| "resume"
	| "resumeById"
	| "conversationList"
	| "fork"
	| "accountIsolation"
	| "login"
	| "accountPage"
	| "skipPermissions"
	| "workflowDelegate"
	| "model"
	| "headless"
	| "mcp"
	| "configFile"
	| "configDirEnv";

/** 능력 한 줄. `detail`은 그 능력을 실제로 수행하는 명령/플래그다 — 화면이
 *  "지원함"만 말하고 끝내면 사용자는 그게 무엇으로 되는지 알 수 없다. */
export interface ProviderCapability {
	key: ProviderCapabilityKey;
	supported: boolean;
	/** 지원할 때의 근거 문자열(명령·플래그·환경변수). 미지원이면 undefined. */
	detail?: string;
}

/** 대화 ID 재개 명령의 예시 — 실제 id 대신 자리표시자를 넣어 형태만 보여준다.
 *  실행에 쓰이는 것은 spec.resumeId 자체이고 여기서는 표시용이다. */
const SAMPLE_CONVERSATION_ID = "<id>";

function capability(
	key: ProviderCapabilityKey,
	detail: string | undefined | null,
): ProviderCapability {
	// 빈 문자열을 "지원함"으로 세지 않는다 — 매니페스트에 실수로 ""가 들어가면
	// 화면이 근거 없는 지원을 주장하게 된다.
	const value = typeof detail === "string" && detail.trim() !== "" ? detail : undefined;
	return value === undefined
		? { key, supported: false }
		: { key, supported: true, detail: value };
}

/** 이 provider가 선언한 능력 전부. 순서는 화면에 그대로 쓰인다 — 대화 다루기,
 *  계정, 실행 정책 순으로 묶었다. */
export function providerCapabilitiesFor(spec: ProviderSpec): ProviderCapability[] {
	return [
		capability("resume", spec.resumeCmd),
		capability("resumeById", spec.resumeId?.(SAMPLE_CONVERSATION_ID)),
		capability("conversationList", spec.conversationList),
		capability("fork", spec.forkFlag ?? spec.forkSource?.(SAMPLE_CONVERSATION_ID)),
		capability("accountIsolation", spec.configEnv),
		// loginCmd가 없어도 계정 분리를 지원하면 cmd를 그냥 실행하는 것이 곧
		// 로그인 경로다(claude처럼) — 그 사실을 화면이 말할 수 있어야 한다.
		capability("login", spec.loginCmd ?? (spec.configEnv ? spec.cmd : undefined)),
		capability("accountPage", spec.accountUrl),
		capability("skipPermissions", spec.skipPermFlag),
		capability("workflowDelegate", spec.workflowDelegate ? spec.cmd : undefined),
		capability("model", spec.modelFlag),
		capability("headless", spec.headlessFlag),
		capability("mcp", spec.mcpSetup),
		capability("configFile", spec.configFile),
		capability("configDirEnv", spec.configDirEnv),
	];
}

export function providerCapabilities(provider: Provider): ProviderCapability[] {
	return providerCapabilitiesFor(PROVIDERS[provider]);
}

/** 확인된 능력 수 / 물어본 능력 수. 헤더에 그대로 붙는다 — "무엇을 할 수
 *  있나"의 답이 0/9인 provider와 7/9인 provider는 같은 화면에서 다르게
 *  읽혀야 한다. */
export function providerCapabilityScore(provider: Provider): {
	supported: number;
	total: number;
} {
	const rows = providerCapabilities(provider);
	return { supported: rows.filter((row) => row.supported).length, total: rows.length };
}
