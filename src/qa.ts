/**
 * Dev-only runtime diagnostics. Streams window errors, unhandled rejections
 * and smoke-check results to the vite dev server (`qa.log`) so problems in
 * the real Tauri runtime are visible outside the webview.
 */

import { runBootSmokeChecks } from "@/lib/qa/qaSmoke";
import { installQaErrorCapture } from "@/lib/qa/installQaErrorCapture";
import { qaRuntimeErrorLedger } from "@/lib/qa/qaRuntimeErrorLedger";
import { exposeQaHarnessGlobals } from "@/lib/qa/qaHarnessGlobals";
import { qaLog } from "@/lib/qa/qaLog";

export { qaLog } from "@/lib/qa/qaLog";

export function installQa() {
  // DEV always; a production-minified `--mode perf` build also opts in so the
  // frontend perf harness can measure release-representative bundles. A normal
  // production build (MODE="production") tree-shakes this whole module out.
  if (!import.meta.env.DEV && import.meta.env.MODE !== "perf") return;

  installQaErrorCapture(window, console, qaLog, qaRuntimeErrorLedger.record);

  qaLog("boot", {
    tauri: Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__),
    ua: navigator.userAgent.slice(0, 80),
  });
  void import("@/lib/workspace/performance/workspacePerformance").then(
    ({ getWorkspacePerformanceSnapshot }) => {
      const win = window as unknown as {
        __DURE_WORKSPACE_DIAGNOSTICS__?: typeof getWorkspacePerformanceSnapshot;
        __DURE_WORKSPACE_REPORT__?: (afterTransitionSequence?: number) => unknown;
      };
      // 원시 스냅샷.
      win.__DURE_WORKSPACE_DIAGNOSTICS__ = getWorkspacePerformanceSnapshot;
      // 사람이 읽는 요약 — devtools에서 `__DURE_WORKSPACE_REPORT__()`로
      // 데스크탑 전환(⌘1–9) 지연 median/p95(warm/cold)를 바로 본다.
      void import("@/lib/workspace/performance/workspacePerformanceReport").then(
        ({ summarizeWorkspacePerformance }) => {
          win.__DURE_WORKSPACE_REPORT__ = (afterTransitionSequence) =>
            summarizeWorkspacePerformance(getWorkspacePerformanceSnapshot(), { afterTransitionSequence });
        },
      );
    },
  );
  void import("@/lib/terminal/qa/terminalStableDiagnostics").then(
    ({ terminalStableDiagnosticSnapshot }) => {
      (
        window as unknown as {
          __DURE_TERMINAL_STABILITY__?: typeof terminalStableDiagnosticSnapshot;
        }
      ).__DURE_TERMINAL_STABILITY__ = terminalStableDiagnosticSnapshot;
    },
  );
  // 연속 렌더링(스크롤/스트리밍) 프레임 통계 — devtools에서
  // `await __DURE_FRAME_SAMPLE__(3000)`로 실측 FPS/jank를 바로 본다.
  void import("@/lib/platform/frameSampler").then(({ sampleFrames }) => {
    (window as unknown as { __DURE_FRAME_SAMPLE__?: typeof sampleFrames }).__DURE_FRAME_SAMPLE__ =
      sampleFrames;
  });
  // 성능 하네스(Playwright)가 pane을 프로그램적으로 열 수 있게 store와 dock
  // 헬퍼를 노출한다 — DEV 전용. 실제 UI 코드 경로를 그대로 태워 계측한다.
  void Promise.all([
    import("@/store"),
    import("@/lib/workspace/dock"),
    import("@/lib/workspace/dock/dockRegistry"),
    import("@/lib/files/fileViewerPane"),
    import("@/lib/workspace/dock/standaloneShellTerminal"),
    import("@/lib/scm/status/diffBadgesStore"),
  ]).then(([store, dock, dockRegistry, fileViewerPane, standaloneShellTerminal, diffBadges]) => {
    // 리브랜딩 전 QA 하네스의 임시 호환 alias. 새 자동화는 Dure 이름만 쓴다.
    // dock.ts no longer re-exports its former barrel names; recompose the
    // harness namespace from the defining modules so __DURE_DOCK__ keeps the
    // members external QA scripts rely on (getDockview, mountedDockviewEntries,
    // openFileViewer, openHmuxStandaloneTerminalOn, ...).
    exposeQaHarnessGlobals(
      window,
      store.useStore,
      { ...dock, ...dockRegistry, ...fileViewerPane, ...standaloneShellTerminal },
      diffBadges.useDiffBadges,
    );
  });

  // test modes driven by a flag file in the project root (served by vite):
  // `echo full > qa.autorun` → full e2e;
  // `echo imelive > qa.autorun` → IME event overlay
  (async () => {
    let flag = "";
    try {
      flag = (await (await fetch("/__qa_flag")).text()).trim();
    } catch {
      /* dev server without the plugin */
    }
    if (flag.includes("convlist")) runConvListProbe();
    if (flag.includes("fileview")) runFileViewProbe();
    if (flag.includes("diffpane")) runDiffPaneProbe();
    if (flag.includes("deskswitch")) runDeskSwitchProbe();
    if (flag.includes("perf")) runPerfProbe();
    if (flag.includes("agentready")) runAgentReadyProbe();
		const { prepareQaAutorun } = await import("@/lib/qa/qaAutorunSetup");
		if ((await prepareQaAutorun(flag, qaLog)) === "reloading") return;
    if (flag.includes("layout")) runLayoutProbe();
    if (flag.includes("paste")) runPasteProbe();
    if (flag.includes("imelive")) runImeLiveOverlay();
    if (flag.includes("full")) runE2eOnce(true);
	})();
	// 부팅 스모크 — 실제 백엔드에 닿는지 확인하고 qa.log에 남긴다 (lib/qaSmoke).
  void runBootSmokeChecks(qaLog);

  runE2eOnce();
}

// bump to re-run the e2e pass after a reload
const E2E_RUN_ID = "e2e-12";
// opt-in only: e2e mutates visible state (panels, projects, real ssh hosts),
// so it must never run on a normal app start. Enable from devtools with
// `localStorage.qaAutoRun = "1"` (or flip the default while testing).
const QA_AUTORUN = localStorage.getItem("qaAutoRun") === "1";

/** 대화 목록 백엔드: 로컬 claude 이 워크트리의 대화 나열 */
async function runConvListProbe() {
  const { invoke } = await import("@tauri-apps/api/core");
  const r: Record<string, string> = {};
  try {
    const list = await invoke<{ id: string; title: string; mtime: number }[]>(
      "list_conversations",
      { cwd: "/Users/kattpish/Documents/Develop/agent-ide", provider: "claude" },
    );
    r.claudeMain = `OK ${list.length} items${list[0] ? ` | latest: "${list[0].title.slice(0, 30)}"` : ""}`;
    const list2 = await invoke<{ id: string }[]>("list_conversations", {
      cwd: "/Users/kattpish/Documents/Develop/agent-ide/.worktrees/claude-1",
      provider: "claude",
    });
    r.thisWorktree = `OK ${list2.length} items (id=${list2[0]?.id?.slice(0, 8) ?? "-"})`;
  } catch (e) {
    r.err = String(e);
  }
  qaLog("convlist", r);
}

/** 파일 뷰어 백엔드: 로컬 md 읽기 + ssh 원격 읽기(로컬 sshd) */
async function runFileViewProbe() {
  const { invoke } = await import("@tauri-apps/api/core");
  const r: Record<string, string> = {};
  const sshOpts = () => ({
    host: "127.0.0.1",
    port: 2222,
    user: "kattpish",
    auth: "key",
    keyPath: "/tmp/qa-sshd/clientkey",
  });
  try {
    // Keep a non-ASCII character so the UTF-8 base64 encode path stays exercised.
    const md = "# Title\n\n**bold** and `code` — café\n\n- item 1\n- item 2\n";
    await invoke("save_temp_file", { dataB64: btoa(unescape(encodeURIComponent(md))), fileName: "qa-view.md" });
    // 방금 만든 파일 경로를 다시 못 받으므로 알려진 경로로 하나 씀
  } catch (e) {
    r.setup = String(e);
  }
  try {
    // 로컬: README.md 읽기
    const f = await invoke<{ name: string; kind: string; content: string; size: number }>(
      "read_file",
      { path: "/tmp/agent-ide-qa/readme.md" },
    );
    r.local = `OK ${f.name} kind=${f.kind} ${f.size}B len=${f.content.length}`;
  } catch (e) {
    r.local = `FAIL ${e}`;
  }
  try {
    const f = await invoke<{ name: string; kind: string; size: number }>("ssh_read_file", {
      id: null,
      opts: {
        host: "127.0.0.1",
        port: 2222,
        user: "kattpish",
        auth: "key",
        keyPath: "/tmp/qa-sshd/clientkey",
      },
      path: "/tmp/qa-sshd/sshd_config",
    });
    r.ssh = `OK ${f.name} kind=${f.kind} ${f.size}B`;
  } catch (e) {
    r.ssh = `FAIL ${e}`;
  }
  try {
    // ~/ 원격 홈 확장 검증: ~/.ssh 없이 홈에 파일 하나 만들고 ~/ 로 읽기
    const home = await invoke<{ stdout: string }>("ssh_exec_once", {
      opts: sshOpts(),
      cmd: "echo tilde-test > ~/qa-tilde.md && echo ok",
    });
    void home;
    const f = await invoke<{ name: string; kind: string; size: number }>("ssh_read_file", {
      id: null,
      opts: sshOpts(),
      path: "~/qa-tilde.md",
    });
    await invoke("ssh_exec_once", { opts: sshOpts(), cmd: "rm -f ~/qa-tilde.md" }).catch(() => {});
    r.sshTilde = `OK ${f.name} ${f.size}B`;
  } catch (e) {
    r.sshTilde = `FAIL ${e}`;
  }
  qaLog("fileview", r);
}

/** EINTR 재시도 수정이 진짜 EOF(셸 종료)를 삼키지 않는지 검증 —
 *  세션 안에서 exit하면 여전히 session:exit가 발생해야 한다 */
/** Diff Review pane 스모크: 일회용 저장소(커밋된 변경 + 미커밋 변경 +
 *  untracked, 한글 경로 포함)를 만들어 실제 dockview에 pane을 열고 —
 *  파일 목록·±배지·CodeMirror 라인 강조·파일별 필터링을 DOM으로 검증하고,
 *  pane 사용 전후로 사용자 git index가 불변인지 확인한다.
 *  실행: `echo diffpane > qa.autorun` 후 tauri dev. */
/**
 * 실사용 토폴로지의 데스크탑 전환 재현: 실제 hmux standalone 세션으로
 * 터미널 9개짜리 데스크탑 A + 2개짜리 B를 만들고 A↔B를 왕복하며
 * warm/cold·remount 분해·마운트 상태를 qa.log로 덤프한다. 판정은 스모크
 * 스크립트가 한다(재현 리포트가 목적 — 나쁜 수치도 성공적 재현).
 */
async function runDeskSwitchProbe() {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const [{ useStore }, dock, perf, reportModule] = await Promise.all([
      import("@/store"),
      import("@/lib/workspace/dock"),
      import("@/lib/workspace/performance/workspacePerformance"),
      import("@/lib/workspace/performance/workspacePerformanceReport"),
    ]);
    const state = () => useStore.getState();
    // hmux standalone 폴백 원인은 console.warn으로만 남는다 — qa.log로 승격.
    const originalWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.includes("hmux")) qaLog("deskswitch-warn", text);
      originalWarn(...args);
    };
    await sleep(4000);
    const a = state().activeSpaceId;
    if (!a) throw new Error("no active desktop");
    // 초기 터미널 1개 + 8개 추가 = 활성 데스크탑 터미널 9개(실측 재현).
    for (let i = 0; i < 8; i++) {
      dock.openLocalTerminalPanel(a);
      await sleep(700);
    }
    await sleep(6000);
    const b = state().addSpace({ activate: true });
    await sleep(2500);
    dock.openLocalTerminalPanel(b);
    await sleep(700);
    dock.openLocalTerminalPanel(b);
    await sleep(5000);
    for (let i = 0; i < 5; i++) {
      state().setActiveSpace(a);
      await sleep(1500);
      state().setActiveSpace(b);
      await sleep(1500);
    }
    const snapshot = perf.getWorkspacePerformanceSnapshot();
    const report = reportModule.summarizeWorkspacePerformance(snapshot);
    // pane 바인딩 런타임 분포 — 실제 hmux 연결(hmux_standalone_v1) 여부의
    // 직접 증거. legacy 폴백이면 원인이 deskswitch-warn 로그에 남는다.
    const bindingRuntimes: Record<string, number> = {};
    for (const layout of Object.values(state().layouts)) {
      for (const panel of Object.values(
        (layout as { panels?: Record<string, { params?: { binding?: { runtime?: string } } }> })
          ?.panels ?? {},
      )) {
        const runtime = panel?.params?.binding?.runtime ?? "none";
        bindingRuntimes[runtime] = (bindingRuntimes[runtime] ?? 0) + 1;
      }
    }
    qaLog("deskswitch", {
      bindingRuntimes,
      totals: snapshot.totals,
      switchPaint: report.switchPaint,
      remountCost: report.remountCost,
      remountAttach: report.remountAttach,
      terminalAttach: report.terminalAttach,
      roundtrip: snapshot.transitions.slice(-10).map((transition) => ({
        warm: transition.warm,
        cacheState: transition.cacheState,
        paint: transition.workspacePaintMs,
        term: transition.firstTerminalPaintMs,
      })),
    });
  } catch (error) {
    qaLog("deskswitch", { error: String(error) });
  }
}
async function runDiffPaneProbe() {
  const { invoke } = await import("@tauri-apps/api/core");
  const { useStore } = await import("@/store");
  const { useWindowSidebarStore } = await import("@/lib/sidebar/windowSidebarStore");
  const r: Record<string, string> = {};
  const repo = "/tmp/dure-diffpane-qa";
  const agentId = "qa-diffpane-agent";
  const sh = (cmd: string) =>
    invoke<{ stdout: string; stderr: string; code: number }>("run_shell", { cmd });
  const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const rowsWith = (t: string) =>
    Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.includes(t));
  const editorText = () => document.querySelector(".cm-content")?.textContent ?? "";
  let projectId = "";
  try {
    // main에 1커밋 → agent 브랜치에 커밋된 수정 + 미커밋 수정 + untracked 2개.
    const setup = await sh(
      `rm -rf ${repo} && mkdir -p ${repo} && cd ${repo} && ` +
        `git init -q -b main && ` +
        `printf 'one\\ntwo\\n' > a.txt && git add . && ` +
        `git -c user.email=qa@qa -c user.name=qa -c commit.gpgsign=false commit -q -m base && ` +
        `git checkout -q -b agent/qa-diff && printf 'one\\ntwo\\nthree\\n' > a.txt && ` +
        `git -c user.email=qa@qa -c user.name=qa -c commit.gpgsign=false commit -q -am change && ` +
        `printf 'one\\ntwo\\nthree\\nfour\\n' > a.txt && printf 'hello\\n' > new.txt && ` +
        `printf '안녕\\n' > 한글.md && echo done`,
    );
    r.setup = setup.code === 0 ? "OK" : `FAIL ${setup.stderr}`;
    const statusBefore = (await sh(`cd ${repo} && git status --porcelain`)).stdout;

    // provider 세션 스폰 없이 pane이 필요로 하는 최소 레코드만 시드한다.
    const project = await useStore.getState().addLocalProject(repo);
    projectId = project.id;
    useStore.setState((s) => ({
      agents: [
        ...s.agents,
        {
          id: agentId,
          name: "qa-diff",
          provider: "claude",
          projectId: project.id,
          worktreePath: repo,
          branch: "agent/qa-diff",
          sessionId: "qa-none",
          sessionKind: "pty",
        },
      ],
    }));
    const { openDiffPanel } = await import("@/lib/workspace/dock/openScmPanel");
    openDiffPanel(useStore.getState().activeSpaceId, agentId, "qa-diff");
    await wait(3000);

    const text = document.body.innerText;
    r.panelTab = text.includes("Diff · qa-diff") ? "OK" : "FAIL";
    r.fileList =
      text.includes("a.txt") && text.includes("new.txt") && text.includes("한글.md")
        ? "OK"
        : "FAIL";
    r.totals = /\+4\s*−0/.test(text.replace(/\n/g, " "))
      ? "OK"
      : `FAIL ${(text.match(/\+\d+ ?−\d+/) ?? []).join(",")}`;
    r.baseHeader = text.includes("main @") ? "OK" : "FAIL";
    r.addLines = String(document.querySelectorAll(".cm-diffline-add").length);
    r.allFilesDiff = editorText().includes("+four") ? "OK" : "FAIL";

    rowsWith("new.txt")[0]?.click();
    await wait(600);
    r.fileSelect =
      editorText().includes("hello") && !editorText().includes("+four") ? "OK" : "FAIL";

    // The Korean fixture's raw numstat and diff-header paths must agree,
    // detecting a core.quotepath pinning regression.
    rowsWith("한글.md")[0]?.click();
    await wait(600);
    r.koreanSelect = editorText().includes("안녕") ? "OK" : "FAIL";

    // ± 배지는 Spaces의 열리지 않은 에이전트 행에도 있어야 한다. 제거된 Agents
    // 탭으로 되돌아가지 않도록 실제 사용자 표면에서 selector를 검증한다.
    useWindowSidebarStore.getState().setTab("spaces");
    await wait(300);

    // 사이드바 ± 배지 (5s 폴링 tier) — 나타날 때까지 최대 12s 대기.
    let badgeBtn: Element | null = null;
    for (let i = 0; i < 12 && !badgeBtn; i++) {
      await wait(1000);
      badgeBtn = document.querySelector('button[title*="fork-point"]');
    }
    r.sidebarBadge =
      badgeBtn?.textContent?.replace(/\s+/g, "") === "+4−0"
        ? "OK"
        : `FAIL ${badgeBtn?.textContent ?? "missing"}`;

    // Add a T3 line comment to the Korean fixture, then verify an English UI
    // failed send leaves it undelivered (session not found).
    const btnMatching = (re: RegExp) =>
      Array.from(document.querySelectorAll("button")).filter((b) =>
        re.test((b.textContent ?? "").trim()),
      );
    const commentTa = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder*="Comment on"]',
    );
    if (commentTa) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(commentTa, "QA-comment-77: check this line");
      commentTa.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(200);
      btnMatching(/^Add at L\d+$/)[0]?.click();
      await wait(300);
    }
    const withComment = document.body.innerText;
    r.lineCommentAdded =
      withComment.includes("QA-comment-77") && /:L\d+/.test(withComment) ? "OK" : "FAIL";
    btnMatching(/^Send \(\d+\)$/)[0]?.click();
    await wait(1500);
    const afterSend = document.body.innerText;
    r.sendFailsUndelivered =
      afterSend.includes("session not found") &&
      afterSend.includes("QA-comment-77") &&
      !document.querySelector('[title="Delivered"]')
        ? "OK"
        : "FAIL";

    const { runDiffPaneHookProbe } = await import("@/qa/diffPaneHookProbe");
    Object.assign(r, await runDiffPaneHookProbe(agentId, wait));

    const statusAfter = (await sh(`cd ${repo} && git status --porcelain`)).stdout;
    r.indexUnchanged =
      statusBefore === statusAfter && statusAfter.includes("?? new.txt")
        ? "OK"
        : `FAIL before=[${statusBefore}] after=[${statusAfter}]`;
  } catch (e) {
    r.error = String(e);
  } finally {
    // Project removal owns cleanup for its fake, sessionless Agent too.
    try {
      if (projectId) {
        const { removeProjectWithResources } = await import(
          "@/lib/agents/resourceLifecycle"
        );
        await removeProjectWithResources(projectId);
      }
    } catch (e) {
      r.cleanup = String(e);
    }
    await sh(`rm -rf ${repo}`).catch(() => {});
  }
  qaLog("diffpane", r);
}

/**
 * 프론트엔드 성능 record-only 프로브. 실측 수치를 bash가 읽는 qa.log로 흘린다.
 * 매 라운드: 3초 rAF 프레임 샘플 + 전환/터미널/pane-open 요약 리포트를 덤프한다.
 * 그 사이 사용자가 데스크탑을 전환하거나 pane을 열면 다음 라운드에 반영된다.
 * 유한 라운드(약 4분) 후 스스로 멈춘다 — 무한 루프로 리소스를 잡지 않는다.
 */
async function runPerfProbe() {
  const [{ getWorkspacePerformanceSnapshot }, { summarizeWorkspacePerformance }, { sampleFrames }] =
    await Promise.all([
      import("@/lib/workspace/performance/workspacePerformance"),
      import("@/lib/workspace/performance/workspacePerformanceReport"),
      import("@/lib/platform/frameSampler"),
    ]);
  const ROUNDS = 24;
  const FRAME_WINDOW_MS = 3000;
  for (let round = 1; round <= ROUNDS; round++) {
    const frames = await sampleFrames(FRAME_WINDOW_MS);
    const report = summarizeWorkspacePerformance(getWorkspacePerformanceSnapshot());
    qaLog("perf", { round, frames, report });
    if (round < ROUNDS) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  qaLog("perf", "done");
}

/**
 * managed 에이전트 provider-ready 실측 (bd 6gy). 실제 provider TUI를 스폰해
 * cold(프로바이더 첫 스폰)/warm을 분리 집계하고, 세션·에이전트는 라운드마다
 * 즉시 정리한다. preflight(로그인셸)/create(broker→host→ready-poll) 분해 포함.
 * 원칙: 한 라운드/프로바이더 실패가 이미 수집한 측정치를 지우지 않고, 정리
 * 실패가 결과 로그를 막지 않으며, 프로브 이전의 전역 샘플은 요약에서 뺀다.
 */
async function runAgentReadyProbe() {
  // 실스폰 프로브 — installQa는 모든 웹뷰에서 돌므로 pop-out 창이 있으면
  // 스폰이 창 수만큼 배가된다. spawn.v2와 같은 main 창 게이트를 쓴다.
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  if (getCurrentWebviewWindow().label !== "main") return;
  const [
    { useStore },
    { addAgent },
    { ensureManagedAgentRuntime, MANAGED_BOOTSTRAP_GEOMETRY },
    { removeAgentWithResources, removeProjectWithResources },
    { getWorkspacePerformanceSnapshot },
    { summarizeWorkspacePerformance },
  ] = await Promise.all([
    import("@/store"),
    import("@/lib/agents/agentRegistration"),
    import("@/lib/sessions/managed/managedAgentRuntime"),
    import("@/lib/agents/resourceLifecycle"),
    import("@/lib/workspace/performance/workspacePerformance"),
    import("@/lib/workspace/performance/workspacePerformanceReport"),
  ]);
  const st = () => useStore.getState();
  const r: Record<string, string> = {};
  const errors: string[] = [];
  let project: { id: string } | null = null;
  // 프로바이더당 1 cold + (ROUNDS-1) warm — p95는 warm 표본에서 유의미해진다.
  // 주의: 프로브 이전에 같은 provider를 스폰했다면 cold 라운드도 warm으로
  // 기록된다(시작 시점 판정) — 아래에서 raw 샘플을 함께 남겨 해석 가능하게 한다.
  const ROUNDS = 5;
  // 프로브 시작 전 샘플은 요약에서 제외한다 (전역 tracker 오염 차단).
  const baselineSeq = getWorkspacePerformanceSnapshot().agentReady.reduce(
    (max, sample) => Math.max(max, sample.sequence),
    0,
  );
  try {
    // mkdir IPC가 없어 항상 존재하는 /tmp를 작업 디렉토리로 쓴다.
    project = await st().addLocalProject("/tmp");
    for (const provider of ["claude", "codex"] as const) {
      for (let round = 1; round <= ROUNDS; round++) {
        let agent: Awaited<ReturnType<typeof addAgent>> | null = null;
        try {
          agent = await addAgent({
            projectId: project.id,
            name: `qa-ready-${provider}-${round}`,
            provider,
            useWorktree: false,
          });
          await ensureManagedAgentRuntime(agent, MANAGED_BOOTSTRAP_GEOMETRY);
        } catch (e) {
          errors.push(`${provider}#${round}: ${e}`);
          // CLI 부재 등이면 남은 라운드도 같은 이유로 실패한다 — 다음 provider로.
          if (agent) await cleanupQaManagedAgent(agent);
          break;
        }
        await cleanupQaManagedAgent(agent);
      }
    }
  } catch (e) {
    errors.push(String(e));
  } finally {
    // 프로젝트 제거는 라운드 정리에 실패해 남은 managed 에이전트까지
    // stop→finalize로 함께 걷어낸다 (removeProject 단독은 그 경우 throw).
    try {
      if (project) await removeProjectWithResources(project.id);
    } catch (e) {
      errors.push(`removeProject: ${e}`);
    }
  }
  // 정리 헬퍼: 검증된 stop 영수증 → finalize(레코드 제거)의 canonical 경로만
  // 쓴다. stop 실패 시 레코드가 남고, 최종 정리는 위 finally가 재시도한다.
  async function cleanupQaManagedAgent(agent: { id: string }) {
    try {
      await removeAgentWithResources(agent.id);
    } catch (e) {
      errors.push(`cleanup ${agent.id}: ${e}`);
    }
  }
  const snapshot = getWorkspacePerformanceSnapshot();
  const mine = snapshot.agentReady.filter((sample) => sample.sequence > baselineSeq);
  const report = summarizeWorkspacePerformance({ ...snapshot, agentReady: mine });
  r.result = JSON.stringify(report.agentReady);
  r.samples = JSON.stringify(mine);
  if (errors.length) r.errors = errors.join(" | ");
  qaLog("agentready", r);
}

/** Measure vertical geometry to find unwanted gaps between the terminal
 *  content and the bottom desktop bar. */
function runLayoutProbe() {
  setTimeout(() => {
    const r: Record<string, string> = {};
    const rect = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e) return "none";
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return `top=${Math.round(b.top)} bottom=${Math.round(b.bottom)} h=${Math.round(b.height)} pad=${cs.padding} margin=${cs.margin} bg=${cs.backgroundColor}`;
    };
    r.main = rect("main");
    r.dvRoot = rect(".dv-dockview");
    r.groupview = rect(".dv-groupview");
    r.content = rect(".dv-content-container");
    r.panelBody = rect(".dv-groupview .flex.h-full.flex-col, .dv-groupview > * > *");
    r.terminalHost = rect(".structured-terminal-host");
    r.terminalPresentation = rect(
      '[data-testid="structured-terminal-presentation"]',
    );
    r.footer = rect("footer");
    qaLog("layout", r);
  }, 1500);
}

/** Verify the paste-image backend command: local temp save. */
async function runPasteProbe() {
  const { invoke } = await import("@tauri-apps/api/core");
  const r: Record<string, string> = {};
  // 1x1 red png
  const dataB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  try {
    const p = await invoke<string>("save_temp_image", { dataB64, ext: "png" });
    r.local = `OK ${p}`;
  } catch (e) {
    r.local = `FAIL ${e}`;
  }
  // The interactive-SSH upload half of this probe retired with the legacy
  // session daemon (2026-08-16) - remote image paste has no transport now.
  qaLog("paste", r);
}

/** Visible overlay logging real keyboard/composition events anywhere in the
 *  app (capture phase) + a plain textarea for comparison. Lets a human type
 *  Hangul and see exactly which events fire on which element. */
function runImeLiveOverlay() {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;right:8px;bottom:8px;width:420px;height:300px;z-index:99999;" +
    "background:rgba(10,10,10,.95);border:1px solid #444;border-radius:8px;" +
    "font:10px/1.5 monospace;color:#ddd;display:flex;flex-direction:column;padding:6px;gap:4px";
  const ta = document.createElement("textarea");
  ta.placeholder = "Type Hangul here (plain textarea) to compare";
  ta.style.cssText =
    "width:100%;height:44px;background:#1a1a1a;color:#eee;border:1px solid #555;" +
    "border-radius:4px;font:12px monospace;padding:4px;resize:none";
  const log = document.createElement("div");
  log.style.cssText = "flex:1;overflow-y:auto;white-space:pre-wrap;word-break:break-all";
  box.appendChild(ta);
  box.appendChild(log);
  document.body.appendChild(box);

  const lines: string[] = [];
  const add = (msg: string) => {
    lines.push(msg);
    if (lines.length > 80) lines.shift();
    log.textContent = lines.join("\n");
    log.scrollTop = log.scrollHeight;
    qaLog("imelive", msg);
  };

  const describe = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    if (!el) return "?";
    if (el === ta) return "PLAIN";
    if (el.matches(".structured-terminal-host textarea")) return "TERMINAL";
    return `${el.tagName}.${el.className?.toString().slice(0, 20)}`;
  };

  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
    document.addEventListener(
      type,
      (e) => add(`${type}(${(e as CompositionEvent).data ?? ""}) @${describe(e.target)}`),
      true,
    );
  }
  document.addEventListener(
    "keydown",
    (e) => {
      const k = e as KeyboardEvent;
      add(`keydown key=${JSON.stringify(k.key)} code=${k.code} keyCode=${k.keyCode} composing=${k.isComposing} @${describe(e.target)}`);
    },
    true,
  );
  document.addEventListener(
    "beforeinput",
    (e) => {
      const i = e as InputEvent;
      add(`beforeinput type=${i.inputType} data=${JSON.stringify(i.data)} @${describe(e.target)}`);
    },
    true,
  );
  add("IME live log started — type Hangul into the terminal and the textarea above");
}

function runE2eOnce(force = false) {
  if (!force && !QA_AUTORUN) return;
  if (sessionStorage.getItem("qa-e2e") === E2E_RUN_ID) return;
  sessionStorage.setItem("qa-e2e", E2E_RUN_ID);

  (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const git = await import("@/lib/ipc/git");
    const r: Record<string, string> = {};
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const v = await fn();
        r[name] = `OK ${JSON.stringify(v)?.slice(0, 140)}`;
      } catch (e) {
        r[name] = `FAIL ${String(e)}`;
      }
    };

    // worktree lifecycle on a throwaway repo
    await step("create_worktree", () =>
      git.createWorktree("/tmp/agent-ide-qa", "qa-agent"),
    );
    await step("worktree_git_status", () =>
      git.gitStatus("/tmp/agent-ide-qa/.worktrees/qa-agent"),
    );
    const checkoutInstance = git.captureGitCheckoutInstance(
      "/tmp/agent-ide-qa",
      "/tmp/agent-ide-qa/.worktrees/qa-agent",
    );
    await step("capture_worktree_instance", () => checkoutInstance);
    await step("remove_worktree_instance", async () =>
      git.removeGitCheckoutInstance("/tmp/agent-ide-qa", await checkoutInstance, "require_clean"),
    );

    // panel management: open a terminal panel in the active desktop and make
    // sure dockview tracks + serializes it
    await step("panel_layout", async () => {
      const { useStore } = await import("@/store");
      const { getDockview } = await import("@/lib/workspace/dock/dockRegistry");
      const { openLocalTerminalPanel } = await import("@/lib/workspace/dock");
      const desktopId = useStore.getState().activeSpaceId;
      const api = getDockview(desktopId);
      if (!api) return "no dockview registered";
      const before = api.panels.length;
      openLocalTerminalPanel(desktopId, "/tmp");
      await new Promise((res) => setTimeout(res, 1500));
      const after = api.panels.length;
      const serialized = JSON.stringify(api.toJSON()).length;
      const added = api.panels[api.panels.length - 1];
      added?.api.close();
      return { before, after, serialized };
    });


    // ssh against a throwaway local sshd (127.0.0.1:2222, key auth)
    const sshOpts = {
      host: "127.0.0.1",
      port: 2222,
      user: "kattpish",
      auth: "key",
      keyPath: "/tmp/qa-sshd/clientkey",
    };
    await step("ssh_exec_once", () =>
      invoke("ssh_exec_once", { opts: sshOpts, cmd: "echo REMOTE_OK && uname" }),
    );
    // desktop switching: only the active desktop's dockview may be displayed
    await step("desktop_switch", async () => {
      const { useStore } = await import("@/store");
      const st = () => useStore.getState();
      const firstId = st().activeSpaceId;
      st().addSpace();
      await new Promise((res) => setTimeout(res, 500));
      const secondId = st().activeSpaceId;
      const visibleCounts = () => {
        const divs = Array.from(document.querySelectorAll("main > div"));
        return {
          total: divs.length,
          visible: divs.filter((d) => getComputedStyle(d).display !== "none").length,
        };
      };
      const afterAdd = visibleCounts();
      st().setActiveSpace(firstId);
      await new Promise((res) => setTimeout(res, 300));
      const afterBack = visibleCounts();
      st().removeSpace(secondId);
      return {
        switchedOnAdd: secondId !== firstId,
        afterAdd,
        afterBack,
        backToFirst: st().activeSpaceId === firstId,
      };
    });


    // the user's actual Tailscale SSH host — none-auth must succeed
    await step("tailscale_ssh_real_host", () =>
      invoke("ssh_exec_once", {
        opts: { host: "100.115.233.110", user: "gate1", auth: "auto" },
        cmd: "echo TAILSCALE_OK && whoami && which tmux",
      }),
    );

    qaLog("e2e", r);
  })();
}
