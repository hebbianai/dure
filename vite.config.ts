// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { resolveAppChannel } from "./scripts/lib/app-channel.mjs";
import dureSourcePlugin from "./scripts/lib/babel-dure-source.mjs";
import { tryBackendRuntimeFingerprint } from "./scripts/lib/backend-runtime-fingerprint.mjs";
import { scopeChildIndexSelectors } from "./scripts/lib/css-child-index-scope.mjs";
import { devDeployLockPath } from "./scripts/lib/dev-deploy-lock.mjs";
import {
  DEV_LAUNCH_FRONTEND_GENERATION_ENV,
  DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
  DEV_LAUNCH_FRONTEND_READY_PATH,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  parseDevLaunchFrontendReady,
} from "./scripts/lib/dev-launch-contract.mjs";
import { createCoordinatedDeployHmrPlugin } from "./scripts/lib/vite-coordinated-deploy-hmr.mjs";
import { requireCurrentNodeDependencyInstall } from "./scripts/node-dependency-preflight.mjs";
import { resolveQaLogPath } from "./scripts/qa/lib/qa-log-receipt.mjs";
import { createFrontendRuntimeObservation } from "./src/contracts/frontendRuntimeObservation.mjs";

const host = process.env.TAURI_DEV_HOST;
const BUILD_INFO_CACHE_MS = 1_000;
const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
).version as string;

function currentRuntimeSource() {
  try {
    const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      {
        cwd: __dirname,
        encoding: "utf8",
      },
    ).trim();
    return {
      buildId: `${packageVersion}+${revision}${dirty ? "-dirty" : ""}`,
      sourceRevision: revision,
      worktreeOverlay: dirty ? ("present" as const) : ("clean" as const),
    };
  } catch {
    return {
      buildId: `${packageVersion}+unknown`,
      sourceRevision: null,
      worktreeOverlay: "unknown" as const,
    };
  }
}

let cachedBuildInfo:
  | { value: ReturnType<typeof computeBuildInfo>; expiresAt: number }
  | undefined;

function computeBuildInfo() {
  return createFrontendRuntimeObservation({
    ...currentRuntimeSource(),
    backendRuntimeFingerprint: tryBackendRuntimeFingerprint(__dirname),
  });
}

function currentBuildInfo() {
  const now = Date.now();
  if (cachedBuildInfo && cachedBuildInfo.expiresAt > now) {
    return cachedBuildInfo.value;
  }
  const value = computeBuildInfo();
  cachedBuildInfo = { value, expiresAt: now + BUILD_INFO_CACHE_MS };
  return value;
}

/** @lezer/* 중 문법 파서인 것 — common·highlight·lr은 코어(에디터·테마가 쓴다). */
const LEZER_CORE = ["/@lezer+common", "/@lezer+highlight", "/@lezer+lr"];

function isLanguageParser(normalized: string): boolean {
  if (!normalized.includes("/@lezer+")) return false;
  return !LEZER_CORE.some((core) => normalized.includes(core));
}

function frontendChunk(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");
  if (!normalized.includes("/node_modules/")) return undefined;
  if (normalized.includes("/@xterm+")) return "terminal";
  if (normalized.includes("/dockview-")) return "dockview";
  // 언어 문법은 editor 청크에 묶지 않는다 — 열린 파일의 것만 동적으로
  // 받아야 하므로(src/lib/codeLangLoader.ts) Rollup이 import 지점별 청크로
  // 나누게 undefined를 돌려준다. 여기서 "editor"로 묶으면 코드가 동적
  // import를 해도 번들은 하나로 합쳐진다 — 두 곳이 함께 성립하는 계약이다.
  if (
    normalized.includes("/@codemirror+lang-") ||
    normalized.includes("/@codemirror+legacy-modes") ||
    isLanguageParser(normalized)
  ) {
    return undefined;
  }
  // 코드 에디터 코어 — 파일을 열 때만 필요하므로 메인 청크에서 떼어낸다.
  if (
    normalized.includes("/@codemirror+") ||
    normalized.includes("/codemirror@") ||
    normalized.includes("/@lezer+")
  ) {
    return "editor";
  }
  if (
    normalized.includes("/react-markdown@") ||
    normalized.includes("/remark-") ||
    normalized.includes("/rehype-") ||
    normalized.includes("/highlight.js@") ||
    normalized.includes("/micromark") ||
    normalized.includes("/unified@")
  ) {
    return "markdown";
  }
  if (
    normalized.includes("/radix-ui@") ||
    normalized.includes("/@radix-ui+") ||
    normalized.includes("/lucide-react@")
  ) {
    return "ui";
  }
  if (
    normalized.includes("/react@") ||
    normalized.includes("/react-dom@") ||
    normalized.includes("/scheduler@") ||
    normalized.includes("/zustand@")
  ) {
    return "react";
  }
  if (normalized.includes("/@tauri-apps+")) return "tauri";
  return undefined;
}

// dev-only: the app posts runtime logs/errors here so they can be inspected
// outside the webview (see src/qa.ts)
const qaLog = (): Plugin => ({
  name: "qa-log",
  configureServer(server) {
    const logPath = resolveQaLogPath({ worktreeRoot: __dirname });
    server.middlewares.use("/__qa_flag", (_req, res) => {
      const stateRoot = process.env.DURE_QA_STATE_ROOT?.trim();
      const candidates = [
        stateRoot ? path.join(stateRoot, "qa.autorun") : undefined,
        path.resolve(__dirname, "qa.autorun"),
      ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          res.end(fs.readFileSync(candidate, "utf8"));
          return;
        } catch {
          // Try the legacy worktree flag before returning an empty response.
        }
      }
      res.end("");
    });
    server.middlewares.use("/__app_build_info", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(currentBuildInfo()));
    });
    server.middlewares.use("/__qa_log", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        fs.appendFileSync(
          logPath,
          `[${new Date().toISOString()}] ${body}\n`,
        );
        res.end("ok");
      });
    });
  },
});

const devFrontendAuthority = (): Plugin[] => {
  const generation = process.env[DEV_LAUNCH_FRONTEND_GENERATION_ENV];
  if (generation === undefined) return [];
  // The optimizer retains its boot-time dependency graph across child restarts.
  // Readiness must publish that graph, not the lockfile currently on disk.
  const nodeDependencyFingerprint = requireCurrentNodeDependencyInstall(__dirname).fingerprint;
  const channel = resolveAppChannel(process.env);
  const ready = parseDevLaunchFrontendReady(
    {
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
      type: "frontend_ready",
      channel,
      generation,
    },
    { channel, generation },
  );
  return [
    {
      name: "dev-frontend-authority",
      configureServer(server) {
        server.middlewares.use(DEV_LAUNCH_FRONTEND_READY_PATH, (_req, res) => {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            ...ready,
            backendRuntimeFingerprint: initialBuildInfo.backendRuntimeFingerprint,
            nodeDependencyFingerprint,
          }));
        });
      },
    },
  ];
};

const initialBuildInfo = currentBuildInfo();

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [
    process.env.VITE_DURE_WORKTREE_RELEASE_PROFILE ? {
      name: "worktree-release-presentation-bootstrap",
      apply: "build" as const,
      transformIndexHtml: {
        order: "pre" as const,
        handler: (html: string) => html.replace(
          'src="/src/main.tsx"', 'src="/src/worktreeReleaseBootstrap.ts"',
        ),
      },
    } : undefined,
    // dev에서만 JSX DOM 요소에 data-dure-src(파일:줄)를 심는다 — Design Mode가
    // 집은 요소의 소스 위치를 에이전트에게 함께 주기 위한 것이다(React 19에서
    // _debugSource가 제거돼 런타임에서 알 방법이 없다). 프로덕션 번들에 넣으면
    // 모든 요소에 파일 경로가 박혀 용량이 늘고 내부 구조가 노출된다.
    react(
      command === "serve"
        ? { babel: { plugins: [[dureSourcePlugin, { root: __dirname }]] } }
        : undefined,
    ),
    tailwindcss(),
    qaLog(),
    ...devFrontendAuthority(),
    createCoordinatedDeployHmrPlugin({
      pathname: devDeployLockPath(),
      worktreeRoot: fs.realpathSync(__dirname),
      channel: resolveAppChannel(process.env),
    }) as Plugin,
  ],

  define: {
    __DURE_FRONTEND_RUNTIME_OBSERVATION__: JSON.stringify(initialBuildInfo),
  },

  css: {
    postcss: { plugins: [scopeChildIndexSelectors()] },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: frontendChunk,
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // + 에이전트 워크트리: `git worktree add`가 프로젝트 안에 새 index.html·src를
      //   통째로 만들어 vite가 풀 리로드(하얀 화면, 미저장 패널 소실)를 쏘게 된다
      //
      // 반드시 이 프로젝트 루트에 앵커된 절대경로여야 한다. "**/.worktrees/**"
      // 같은 비앵커 글롭은 절대경로의 조상 세그먼트에도 매칭돼, dev 루트
      // 자체가 .worktrees/ 안(워크트리 호스팅 daily driver)이면 자기 소스
      // 전체가 무시돼 HMR이 통째로 죽는다 (2026-07-29 실측: rebase로 파일이
      // 바뀌어도 vite가 무반응).
      ignored: [
        `${path.resolve(__dirname, "src-tauri")}/**`,
        `${path.resolve(__dirname, "hmux/target")}/**`,
        // Disk GC atomically moves large build trees here before deleting
        // them. Those transactions are never frontend source, but without an
        // explicit boundary every removal is delivered through FSEvents and
        // can saturate the daily-driver Vite process for minutes.
        `${path.resolve(__dirname, ".dure-reclaim")}/**`,
        `${path.resolve(__dirname, ".worktrees")}/**`,
        `${path.resolve(__dirname, ".claude/worktrees")}/**`,
      ],
    },
  },
}));
