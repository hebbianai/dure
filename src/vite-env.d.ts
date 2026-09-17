/// <reference types="vite/client" />

declare const __DURE_FRONTEND_RUNTIME_OBSERVATION__: import("./contracts/frontendRuntimeObservation.mjs").FrontendRuntimeObservation;

interface ImportMetaEnv {
  readonly VITE_DURE_APP_CHANNEL?: string;
  readonly VITE_DURE_WORKTREE_RELEASE_PROFILE?: string;
  readonly VITE_DURE_HMUX_STANDALONE?: string;
  readonly VITE_DURE_INTERFACE_MODE_POLICY?: "basic-only";
  /** Legacy build input; new launchers emit VITE_DURE_APP_CHANNEL only. */
  readonly VITE_HEBBIAN_APP_CHANNEL?: string;
  /** Local-testing override for the feedback intake endpoint (lib/ipc/feedback.ts). */
  readonly VITE_DURE_FEEDBACK_ENDPOINT?: string;
}

// ?raw 임포트 — Design Mode 주입 번들을 문자열로 읽는다.
declare module "*?raw" {
  const content: string;
  export default content;
}
