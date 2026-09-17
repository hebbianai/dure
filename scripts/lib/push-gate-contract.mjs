export const PUSH_GATE_ORDER = Object.freeze([
  // The all-JS gate substitution in scriptForPushGateScope assumes frontend
  // is the first scope; keep frontend first.
  "frontend",
  "design-coverage",
  "tooling",
  "qa-tooling",
  "script-tests",
  "app-core",
  "process",
  "sampler",
  // 폰과 노트북이 링크하는 와이어 정의, 그리고 그 정의를 링크하는 배포 서비스.
  // 분류기(`push-gate-scope.mjs`)가 이 두 이름을 내놓는데 여기 없으면, 그 크레이트를
  // 건드리는 모든 변경이 "unknown local verification push gate scope" 로 게이트
  // 자체를 못 돌린다 — 2026-08-12 에 실제로 그 상태로 한동안 있었다.
  "hub-protocol",
  "relay",
  // 배포되는 서비스지만 저장소 안의 어떤 크레이트도 이것을 링크하지 않는다 —
  // 그래서 소비자 집합이 자기 자신뿐이고, 이름이 여기 없으면 분류기가 내놓는
  // 스코프를 실행기가 모른다(릴레이가 2026-08-12에 겪은 그 상태).
  "feedback",
  "hmux-core",
  "terminal-state-protocol",
  "hmux-mobile-compat",
  "desktop",
  "mobile-web",
  "mobile-rust",
]);

export const PUSH_GATE_SCRIPTS = Object.freeze({
  "design-coverage": "verify:push:design-coverage",
  frontend: "verify:push:frontend",
  tooling: "verify:push:tooling",
  "qa-tooling": "verify:push:qa-tooling",
  "script-tests": "verify:push:script-tests",
  "app-core": "verify:push:app-core",
  process: "verify:push:process",
  sampler: "verify:push:sampler",
  "hub-protocol": "verify:push:hub-protocol",
  relay: "verify:push:relay",
  feedback: "verify:push:feedback",
  "hmux-core": "verify:push:hmux-core",
  "terminal-state-protocol": "verify:push:terminal-state-protocol",
  "hmux-mobile-compat": "verify:push:hmux-mobile-compat",
  desktop: "verify:push:desktop",
  "mobile-web": "verify:push:mobile-web",
  "mobile-rust": "verify:push:mobile-rust",
});

export const ALL_JAVASCRIPT_GATE_SCRIPT = "verify:push:all-js:checks";

const ALL_JAVASCRIPT_COVERED_GATE_SCRIPTS = Object.freeze({
  tooling: "verify:push:tooling:syntax",
  "qa-tooling": "verify:push:qa-tooling:syntax",
  "script-tests": null,
});

export function scriptForPushGateScope(scope, allScopes = false) {
  const directScript = PUSH_GATE_SCRIPTS[scope];
  if (typeof directScript !== "string") {
    throw new Error(`missing verification script for scope: ${scope}`);
  }
  if (scope === "frontend" && allScopes) return ALL_JAVASCRIPT_GATE_SCRIPT;
  if (
    allScopes &&
    Object.hasOwn(ALL_JAVASCRIPT_COVERED_GATE_SCRIPTS, scope)
  ) {
    return ALL_JAVASCRIPT_COVERED_GATE_SCRIPTS[scope];
  }
  return directScript;
}

export function pushGatePlan(scopes) {
  const allScopes =
    scopes.length === PUSH_GATE_ORDER.length &&
    scopes.every((scope, index) => scope === PUSH_GATE_ORDER[index]);
  return scopes.flatMap((scope) => {
    const script = scriptForPushGateScope(scope, allScopes);
    return script ? [{ scope, script }] : [];
  });
}

export function fullPushGateScriptNames() {
  return PUSH_GATE_ORDER.flatMap((scope) =>
    scriptForPushGateScope(scope, true) ?? [],
  );
}
