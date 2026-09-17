// Design Mode 주입 스크립트 전용 빌드.
//
// 왜 별도 빌드인가: 이 스크립트는 우리 앱이 아니라 **사용자 앱 창**에서 돈다.
// 앱 번들의 모듈 시스템 없이 임의
// 페이지에서 실행돼야 하므로 IIFE 하나로 묶는다. 판정·수집 로직은 앱과 같은
// 모듈을 쓰고, 이 빌드가 그것을 통째로 인라인한다 — 코드를 두 벌 쓰지 않는다.
//
// 산출물(src/generated/designModeInject.js)은 저장소에 커밋한다. 이 저장소는
// 이미 src/contracts/generated/**를 그렇게 다룬다. 소스와 어긋나는 것을 막는
// 검사는 scripts/design-mode-inject-freshness.test.mjs가 담당한다.
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    // 앱 dist를 건드리지 않는다 — 이 빌드는 생성 소스를 만드는 것이다.
    outDir: "src/generated",
    emptyOutDir: false,
    // 페이지에 그대로 붙는 스크립트다: 모듈 preload·해시 파일명이 있으면 안 된다.
    lib: {
      entry: path.resolve(__dirname, "src/designModeInjectEntry.ts"),
      formats: ["iife"],
      name: "__DureDesignModeBundle",
      fileName: () => "designModeInject.js",
    },
    minify: false,
    target: "safari15",
    sourcemap: false,
  },
});
