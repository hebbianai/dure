// 의존 경계 게이트 (dependency-cruiser) — 2026-08-01 폴더 정리와 함께 도입.
//
// 역할 분담: architecture-fitness(자체 게이트)는 "양"의 라쳇(god-file 줄 수,
// 파일별 invoke 횟수, 평면 루트 파일 수)을, 이 설정은 "방향"의 동결(모듈 간
// 의존 방향·신규 위반자 차단)을 맡는다. 실행: pnpm depcruise (verify:frontend
// 에 포함). 예외 목록은 도입 시점(2026-08-01)의 실측 동결이다 — 새 항목 추가
// 금지, 줄이는 것만 허용.

/** 도입 시점에 이미 @tauri-apps/api/core를 직접 임포트하던 파일들.
 *  fitness 게이트의 directTauriInvoke baseline과 같은 부채 집합 — 새 파일이
 *  ipc/ 밖에서 invoke를 직접 쓰는 것은 여기서도 즉시 에러다. */
const DIRECT_TAURI_CORE_DEBT = [
	"^src/App\\.tsx$",
	"^src/components/agents/AccountsDialog\\.tsx$",
	"^src/components/panels/SshPanel\\.tsx$",
	"^src/components/panels/TerminalPanel\\.tsx$",
	"^src/components/search/SearchPane\\.tsx$",
	"^src/components/settings/SettingsDialog\\.tsx$",
	"^src/components/ssh/SshPane\\.tsx$",
	"^src/lib/agents/automations\\.ts$",
	"^src/lib/agents/providerConfig\\.ts$",
	"^src/lib/hmux/hmuxConnectionDiagnostics\\.ts$",
	"^src/lib/persistence/registry\\.ts$",
	"^src/lib/platform/share\\.ts$",
	"^src/lib/scm/git\\.ts$",
	"^src/lib/sessions/sessionLifecycle\\.ts$",
	"^src/lib/settings/notify\\.ts$",
	"^src/lib/terminal/term\\.ts$",
	"^src/lib/terminal/terminalLocalProject\\.ts$",
	"^src/qa\\.ts$",
	"^src/qa/hmuxWindowFocus\\.tsx$",
	"^src/store\\.ts$",
];

module.exports = {
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
	},
	forbidden: [
		{
			name: "invoke-outside-ipc",
			comment:
				"invoke 래퍼는 src/lib/ipc/ 소유 — 새 파일의 직접 @tauri-apps/api/core 임포트 금지",
			severity: "error",
			from: { pathNot: ["^src/lib/ipc(\\.|/)"].concat(DIRECT_TAURI_CORE_DEBT) },
			to: { path: "@tauri-apps/api/core" },
		},
		{
			name: "lib-to-components",
			comment: "로직(lib)은 표면(components)에 의존하지 않는다",
			severity: "error",
			from: { path: "^src/lib" },
			to: { path: "^src/components" },
		},
		{
			name: "terminal-protocol-isolation",
			comment:
				"The terminal wire protocol depends only on its own modules and generated contracts, never client state or presentation.",
			severity: "error",
			from: { path: "^src/lib/terminal/protocol/" },
			to: {
				path: ["^src/", "(^|/)(react|react-dom|zustand|@tauri-apps)(/|$)"],
				pathNot: ["^src/lib/terminal/protocol/", "^src/contracts/"],
			},
		},
		{
			name: "source-does-not-import-xterm",
			comment:
				"application and QA source render Host-projected frames and never import the retired browser parser",
			severity: "error",
			from: { path: "^src/" },
			to: { path: "^node_modules/\\.pnpm/@xterm" },
		},
		{
			name: "terminal-pane-entrypoints-have-no-xterm-closure",
			comment:
				"every product pane entrypoint must remain transitively independent of the retired browser parser",
			severity: "error",
			from: {
				path: [
					"^src/components/terminal/TerminalView\\.tsx$",
					"^src/components/panels/(NativeAgentPanel|TerminalPanel)\\.tsx$",
					"^src/components/workspace/AgentSessionWindow\\.tsx$",
				],
			},
			to: { path: "^node_modules/\\.pnpm/@xterm", reachable: true },
		},
		{
			name: "no-circular",
			comment:
				"순환 의존 금지 — 2026-08-01 도입 시 40개를 타입-leaf 추출 5건으로 전부 해소(40→25→0)하고 error로 동결. 새 순환은 즉시 게이트 실패다.",
			severity: "error",
			from: {},
			to: { circular: true },
		},
		{
			// Tier 0: ui/ primitives are domain-free. They may depend on lib
			// (theme/util helpers) but never on domain clusters, the shared
			// composite tier, or the store.
			name: "ui-tier-purity",
			comment:
				"UI primitives cannot import domain/common components or the store",
			severity: "error",
			from: { path: "^src/components/ui/" },
			to: {
				path: "^src/(store|components/(?!ui/))",
			},
		},
		{
			// Tier 1: common/ composites are reusable across domains. They build
			// on ui/ and lib but must not import domain clusters or the store —
			// domain meaning stays at the call site.
			name: "common-tier-purity",
			comment:
				"common/ 컴포지트는 ui·lib 위에서만 조립한다 — 도메인 클러스터·store 임포트 금지",
			severity: "error",
			from: { path: "^src/components/common/" },
			to: {
				path: "^src/(store|components/(?!(ui|common)/))",
			},
		},
	],
};
