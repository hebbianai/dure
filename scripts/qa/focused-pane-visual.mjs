#!/usr/bin/env node

// Runtime-free visual probe for the real Workspace/Dockview/PaneChrome tree.
// It starts an isolated Vite server, injects the canned Tauri backend, and
// leaves screenshots plus a machine-readable report below output/playwright/.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");
const allowedOutputRoot = resolve(
  repoRoot,
  "output/playwright/focused-pane-visual",
);
const requestedOutputRoot = process.env.FOCUSED_PANE_VISUAL_OUT;
const runId = `run-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}-${process.pid}`;
const outputRoot = resolve(
  requestedOutputRoot ?? resolve(allowedOutputRoot, runId),
);
const outputRelative = relative(allowedOutputRoot, outputRoot);

if (
  outputRoot === allowedOutputRoot ||
  outputRelative === "" ||
  outputRelative.startsWith("..") ||
  isAbsolute(outputRelative)
) {
  throw new Error(
    "FOCUSED_PANE_VISUAL_OUT must name a run directory below output/playwright/focused-pane-visual",
  );
}

await mkdir(outputRoot, { recursive: true });

const server = await createServer({
  root: repoRoot,
  configFile: resolve(repoRoot, "vite.config.ts"),
  logLevel: "warn",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    hmr: false,
  },
});

let browser;

function isTransparent(color) {
  return (
    color === "transparent" ||
    color === "rgba(0, 0, 0, 0)" ||
    color.endsWith(" / 0)")
  );
}

function assertExactlyFocused(snapshot, title) {
  const active = snapshot.panes.filter((pane) => pane.active);
  assert.equal(active.length, 1, "exactly one Dockview group must be active");
  assert.equal(active[0].title, title, `expected ${title} to be focused`);
  assert.equal(
    snapshot.focusedSpaceKeys.length,
    1,
    "exactly one Spaces row must describe the focused pane",
  );
  assert.equal(snapshot.focusedSpaceKeys[0], `agent:${title}`);

  for (const pane of snapshot.panes) {
    assert.equal(
      pane.actions.length,
      1,
      `${pane.title} must render its large-window action`,
    );
    if (pane.active) {
      assert.notEqual(
        pane.focusBoxShadow,
        "none",
        `${pane.title} must render the focused 1px ring`,
      );
    }
  }
}

function assertSameRects(before, after, context) {
  assert.equal(after.length, before.length, `${context}: pane count changed`);
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index].title, before[index].title);
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(
        Math.abs(after[index].rect[key] - before[index].rect[key]) <= 0.5,
        `${context}: ${before[index].title} ${key} shifted`,
      );
    }
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("isolated Vite server did not expose a TCP port");
  }

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error.stack ?? error.message).slice(0, 2_000));
  });

  const tauriMock = await readFile(
    resolve(scriptRoot, "tauri-mock.js"),
    "utf8",
  );
  await page.addInitScript({
    content: `
      {
        const NativeDate = Date;
        const epoch = Date.parse("2026-08-04T09:30:00.000Z");
        const startedAt = performance.now();
        const now = () => epoch + (performance.now() - startedAt);
        function FixtureDate(...args) {
          if (new.target) {
            return args.length === 0 ? new NativeDate(now()) : new NativeDate(...args);
          }
          return new NativeDate(now()).toString();
        }
        Object.setPrototypeOf(FixtureDate, NativeDate);
        FixtureDate.prototype = NativeDate.prototype;
        FixtureDate.now = now;
        globalThis.Date = FixtureDate;
        localStorage.clear();
        localStorage.setItem(
          "agent-ide-main-window-sidebar",
          ${JSON.stringify(
            JSON.stringify({
              state: { open: true, width: 320, tab: "spaces" },
              version: 1,
            }),
          )},
        );
      }
      ${tauriMock}
      {
        const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const value = await invoke(command, args);
          return command === "read_file" && value?.content
            ? { ...value, size: new TextEncoder().encode(value.content).byteLength }
            : value;
        };
      }
    `,
  });

  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(
    () =>
      typeof window.__DURE_STORE__ === "function" &&
      typeof window.__DURE_DOCK__ === "object",
    null,
    { timeout: 20_000 },
  );

  const fixture = await page.evaluate(async () => {
    const store = window.__DURE_STORE__;
    const dock = window.__DURE_DOCK__;
    const state = store.getState();
    const project = {
      id: "project-focused-pane-visual",
      name: "focused-pane-visual",
      path: "/workspace/focused-pane-visual",
      kind: "local",
      isRepo: true,
    };
    const binding = (sessionId, workspaceId) => ({
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "local",
      hostId: "local",
      sessionId,
      workspaceId,
      createIdempotencyKey: `visual-${sessionId}`,
    });
    const agents = [
      {
        id: "focus-left",
        name: "focus-left",
        provider: "codex",
        projectId: project.id,
        worktreePath: `${project.path}/.worktrees/focus-left`,
        branch: "agent/focus-left",
        sessionId: "session-focus-left",
        sessionKind: "pty",
        runtimeBinding: binding("session-focus-left", "workspace-focus-left"),
        started: true,
      },
      {
        id: "focus-right",
        name: "focus-right",
        provider: "codex",
        projectId: project.id,
        worktreePath: `${project.path}/.worktrees/focus-right`,
        branch: "agent/focus-right",
        sessionId: "session-focus-right",
        sessionKind: "pty",
        runtimeBinding: binding("session-focus-right", "workspace-focus-right"),
        started: true,
      },
    ];

    state.setUiPrefs({
      theme: "dark",
      themeScheme: undefined,
      onboardingDismissed: true,
    });
    const desktopId = state.addDesktop({
      name: "Focus QA",
      // A truthy, valid empty layout prevents Workspace from creating its
      // normal first terminal. This fixture owns exactly two panes.
      initialLayout: {
        grid: {
          root: { type: "branch", data: [], size: 1 },
          width: 1,
          height: 1,
          orientation: "HORIZONTAL",
        },
        panels: {},
      },
    });
    store.setState({
      projects: [project],
      pinnedProjects: [project.id],
      agents,
      agentActivity: {
        "focus-left": "waiting",
        "focus-right": "working",
      },
      language: "ko",
    });

    const api = await dock.waitForDesktopDockview(desktopId);
    if (!api) throw new Error("active desktop Dockview did not mount");
    // The header params are identical to a managed Agent pane, while a real
    // file body keeps this chrome-only fixture independent of Hmux transport.
    const addFixturePane = (agent, position) =>
      api.addPanel({
        id: `agent:${agent.id}`,
        component: "fileviewer",
        title: agent.name,
        params: {
          agentId: agent.id,
          sessionId: agent.sessionId,
          binding: agent.runtimeBinding,
          path: `${project.path}/${agent.id}.ts`,
          source: "local",
        },
        ...(position ? { position } : {}),
      });
    addFixturePane(agents[0]);
    addFixturePane(agents[1], {
      referencePanel: "agent:focus-left",
      direction: "right",
    });
    return { desktopId };
  });

  try {
    await page.waitForFunction(
      (desktopId) =>
        document
          .getElementById(`desktop-panel-${desktopId}`)
          ?.querySelectorAll(".dv-groupview:has([data-pane-title])").length ===
          2 &&
        document.querySelectorAll('[data-space-key^="agent:focus-"]').length ===
          2,
      fixture.desktopId,
      { timeout: 20_000 },
    );
  } catch (error) {
    const diagnosis = await page.evaluate((desktopId) => {
      const workspace = document.getElementById(`desktop-panel-${desktopId}`);
      return {
        activeDesktopId: window.__DURE_STORE__.getState().activeDesktopId,
        paneTitles: Array.from(
          workspace?.querySelectorAll("[data-pane-title]") ?? [],
          (title) => title.textContent,
        ),
        spaceKeys: Array.from(
          document.querySelectorAll("[data-space-key]"),
          (row) => row.getAttribute("data-space-key"),
        ),
      };
    }, fixture.desktopId);
    await page.screenshot({
      path: resolve(outputRoot, "00-setup-failure.png"),
      animations: "disabled",
    });
    throw new Error(`focused pane fixture setup timed out: ${JSON.stringify(diagnosis)}`, {
      cause: error,
    });
  }

  const workspaceSelector = `#desktop-panel-${fixture.desktopId}`;
  const paneGroup = (title) =>
    page.locator(`${workspaceSelector} .dv-groupview`).filter({
      has: page.locator("[data-pane-title]", { hasText: title }),
    });
  const leftGroup = paneGroup("focus-left");
  const waitForVisibleActiveActions = () =>
    page.waitForFunction((desktopId) => {
      const actions = document
        .getElementById(`desktop-panel-${desktopId}`)
        ?.querySelectorAll(
          ".dv-groupview.dv-active-group [data-pane-window-action]",
        );
      return (
        actions?.length === 1 &&
        Array.from(actions).every(
          (action) => Number(getComputedStyle(action).opacity) === 1,
        )
      );
    }, fixture.desktopId);

  const snapshot = () =>
    page.evaluate((desktopId) => {
      const workspace = document.getElementById(`desktop-panel-${desktopId}`);
      if (!workspace) throw new Error("focused-pane workspace is missing");
      const panes = Array.from(
        workspace.querySelectorAll(".dv-groupview:has([data-pane-title])"),
      )
        .map((group) => {
          const title = group.querySelector("[data-pane-title]")?.textContent?.trim();
          const groupStyle = getComputedStyle(group);
          const spacesOverlay = getComputedStyle(group, "::after");
          const rect = group.getBoundingClientRect();
          return {
            title,
            active: group.classList.contains("dv-active-group"),
            spacesHovered: group.hasAttribute("data-spaces-pane-hovered"),
            focusBoxShadow: groupStyle.boxShadow,
            spacesBorderColor: spacesOverlay.borderTopColor,
            spacesBorderStyle: spacesOverlay.borderTopStyle,
            spacesBorderWidth: spacesOverlay.borderTopWidth,
            spacesBackground: spacesOverlay.backgroundColor,
            matchesSpacesSelector: group.matches(
              ".dockview-theme-abyss .dv-groupview[data-spaces-pane-hovered]",
            ),
            titleColor: title
              ? getComputedStyle(group.querySelector("[data-pane-title]")).color
              : "missing",
            actions: Array.from(
              group.querySelectorAll("[data-pane-window-action]"),
            ).map((action) => ({
              label: action.getAttribute("aria-label"),
              opacity: Number(getComputedStyle(action).opacity),
            })),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        })
        .sort((left, right) => left.rect.x - right.rect.x);
      return {
        dark: document.documentElement.classList.contains("dark"),
        panes,
        focusedSpaceKeys: Array.from(
          document.querySelectorAll("[data-space-key][data-pane-focused]"),
          (row) => row.getAttribute("data-space-key"),
        ),
      };
    }, fixture.desktopId);

  const screenshots = {};
  const capture = async (name) => {
    const file = resolve(outputRoot, `${name}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    screenshots[name] = {
      file: relative(repoRoot, file),
      sha256: await sha256(file),
    };
  };

  await leftGroup.locator("[data-pane-title]").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-space-key="agent:focus-left"]')
        ?.hasAttribute("data-pane-focused") === true,
  );
  await waitForVisibleActiveActions();
  const pointerFocused = await snapshot();
  assertExactlyFocused(pointerFocused, "focus-left");
  assert.notEqual(
    pointerFocused.panes[0].titleColor,
    pointerFocused.panes[1].titleColor,
    "focused and inactive titles must have different contrast",
  );
  await capture("01-dark-pointer-left");

  await page.keyboard.press("Alt+Meta+ArrowRight");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-space-key="agent:focus-right"]')
        ?.hasAttribute("data-pane-focused") === true,
  );
  await waitForVisibleActiveActions();
  const keyboardFocused = await snapshot();
  assertExactlyFocused(keyboardFocused, "focus-right");
  assertSameRects(pointerFocused.panes, keyboardFocused.panes, "keyboard focus");
  await capture("02-dark-keyboard-right");

  // Command brackets follow focus history, not Dockview's spatial order.
  // Forward at the newest entry is a no-op; back and forward then replay the
  // exact left → right focus journey above.
  await page.keyboard.press("Meta+]");
  const historyForwardAtEnd = await snapshot();
  assertExactlyFocused(historyForwardAtEnd, "focus-right");
  await page.keyboard.press("Meta+[");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-space-key="agent:focus-left"]')
        ?.hasAttribute("data-pane-focused") === true,
  );
  const historyBack = await snapshot();
  assertExactlyFocused(historyBack, "focus-left");
  await page.keyboard.press("Meta+]");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-space-key="agent:focus-right"]')
        ?.hasAttribute("data-pane-focused") === true,
  );
  const historyForward = await snapshot();
  assertExactlyFocused(historyForward, "focus-right");
  assertSameRects(keyboardFocused.panes, historyForward.panes, "focus history");

  await leftGroup.hover({ position: { x: 120, y: 120 } });
  await page.waitForFunction(
    (desktopId) =>
      Array.from(
        document
          .getElementById(`desktop-panel-${desktopId}`)
          ?.querySelectorAll(
            ".dv-groupview:has([data-pane-title]) [data-pane-window-action]",
          ) ?? [],
      ).every((action) => Number(getComputedStyle(action).opacity) === 1),
    fixture.desktopId,
  );
  const paneHovered = await snapshot();
  assertExactlyFocused(paneHovered, "focus-right");
  assert.equal(
    paneHovered.panes.every((pane) =>
      pane.actions.every((action) => action.opacity === 1),
    ),
    true,
    "inactive hover and focused pane actions must be visible together",
  );
  assertSameRects(keyboardFocused.panes, paneHovered.panes, "pane hover");
  await capture("03-dark-left-hover-right-focused");

  await page.locator('[data-space-key="agent:focus-left"]').hover();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.dv-groupview[data-spaces-pane-hovered] [data-pane-title]',
      )?.textContent === "focus-left",
  );
  const spacesHovered = await snapshot();
  assertExactlyFocused(spacesHovered, "focus-right");
  const spacesTarget = spacesHovered.panes.find(
    (pane) => pane.title === "focus-left",
  );
  assert.ok(spacesTarget, "Spaces hover target pane must remain mounted");
  assert.equal(spacesTarget.spacesHovered, true);
  assert.equal(spacesTarget.matchesSpacesSelector, true);
  assert.equal(spacesTarget.spacesBorderStyle, "solid");
  assert.equal(spacesTarget.spacesBorderWidth, "2px");
  assert.equal(isTransparent(spacesTarget.spacesBorderColor), false);
  const focusedTarget = spacesHovered.panes.find(
    (pane) => pane.title === "focus-right",
  );
  assert.ok(focusedTarget, "focused pane must remain mounted during Spaces hover");
  assert.notEqual(
    focusedTarget.focusBoxShadow,
    "none",
    "Spaces hover must not replace the focused pane ring",
  );
  await capture("04-dark-spaces-left-right-focused");

  await page.evaluate(() => {
    window.__DURE_STORE__.getState().setUiPrefs({ theme: "light" });
  });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("dark"),
  );
  const light = await snapshot();
  assertExactlyFocused(light, "focus-right");
  assertSameRects(spacesHovered.panes, light.panes, "theme switch");
  await capture("05-light-spaces-left-right-focused");

  assert.deepEqual(pageErrors, [], "fixture emitted uncaught page errors");

  const report = {
    schemaVersion: 1,
    fixture: "focused-pane-visual",
    appUrl: `http://127.0.0.1:${address.port}`,
    desktopId: fixture.desktopId,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    reducedMotion: true,
    steps: {
      pointerFocused,
      keyboardFocused,
      historyForwardAtEnd,
      historyBack,
      historyForward,
      paneHovered,
      spacesHovered,
      light,
    },
    screenshots,
    pageErrors,
  };
  const reportFile = resolve(outputRoot, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      output: relative(repoRoot, outputRoot),
      report: relative(repoRoot, reportFile),
      screenshots,
    })}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
