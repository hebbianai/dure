// IPC barrel — 도메인 분할 1단계(2026-08-01).
//
// 실제 래퍼는 src/lib/ipc/<domain>.ts 가 소유한다. 213개 소비자의 임포트 경로를
// 보존하기 위해 이 파일은 전량 재-export만 한다. 새 래퍼는 반드시 해당 도메인
// 파일에 추가할 것(여기 직접 추가 금지 — 커맨드 소유권 테스트가 지킨다).
// 2단계(선택): 새 코드부터 도메인 직접 임포트로 이관.

export * from "./ipc/core";
export * from "./ipc/plugins";
export * from "./ipc/hmux";
export * from "./ipc/sessions";
export * from "./ipc/spawn";
export * from "./ipc/git";
export * from "./ipc/github";
export * from "./ipc/externalWorkspace";
export * from "./ipc/files";
export * from "./ipc/conversations";
export * from "./ipc/diffReview";
export * from "./ipc/designMode";
export * from "./ipc/system";
export * from "./ipc/notifications";
export * from "./ipc/persistence";
