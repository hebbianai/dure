#!/usr/bin/env node

// Runtime-free pixel probe for the pane card outline.
//
// The hairline around the workspace deck is the outline of ONE card, so it has
// to read as one unbroken line of one color. Two ways it stopped doing that:
//
//   1. drawn per Dockview group, the outline lost 2px at every inter-pane gap
//      that reaches the card edge — the top line looked snipped between tabs;
//   2. drawn in translucent white, it took the color of whatever sat behind it,
//      so the same edge was one gray along the 32px tab strip and a darker one
//      along the black terminal below it.
//
// Both are invisible to the DOM and only show up in pixels, so this probe
// screenshots the real Workspace/Dockview tree and walks the card's four outer
// rows/columns. Reported 2026-08-10; see docs/architecture/ pane card notes.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");
const allowedOutputRoot = resolve(
  repoRoot,
  "output/playwright/pane-card-outline-visual",
);
const requestedOutputRoot = process.env.PANE_CARD_OUTLINE_VISUAL_OUT;
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
    "PANE_CARD_OUTLINE_VISUAL_OUT must name a run directory below output/playwright/pane-card-outline-visual",
  );
}

await mkdir(outputRoot, { recursive: true });

// The rounded outer corners bend the line, so every walk starts past the arc.
const CORNER_INSET = 20;
// How far past the inter-pane gap the top-edge walk reaches, to compare the
// gap against the outline immediately beside it.
const GAP_MARGIN = 24;
// One straight edge shares one subpixel offset, so its samples must agree
// tightly. Two different edges may not, hence the looser cross-edge bound.
const EDGE_TOLERANCE = 2;
const CROSS_EDGE_TOLERANCE = 6;
// The focus ring has to be a step above the card outline's own contrast, not
// merely non-transparent. rgb(64) outline over an rgb(46) gap is 18.
const FOCUS_RING_MIN_CONTRAST = 20;

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

const channelSpread = (colors) => {
  let spread = 0;
  for (const channel of [0, 1, 2]) {
    const values = colors.map((color) => color[channel]);
    spread = Math.max(spread, Math.max(...values) - Math.min(...values));
  }
  return spread;
};

const describe = (color) => `rgb(${color.slice(0, 3).join(", ")})`;

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
    `,
  });

  // networkidle needs a 500ms quiet window that a loaded machine never gives —
  // the readiness wait below is the real gate, so do not also gate on traffic.
  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      typeof window.__DURE_STORE__ === "function" &&
      typeof window.__DURE_DOCK__ === "object",
    null,
    { timeout: 20_000 },
  );

  // Two panes split left/right: the inter-pane gap reaches the card's top and
  // bottom edges, which is exactly where the outline used to break.
  const fixture = await page.evaluate(async () => {
    const store = window.__DURE_STORE__;
    const dock = window.__DURE_DOCK__;
    const state = store.getState();
    const project = {
      id: "project-pane-card-outline",
      name: "pane-card-outline",
      path: "/workspace/pane-card-outline",
      kind: "local",
      isRepo: true,
    };
    const agents = ["outline-left", "outline-right", "outline-nested"].map((id) => ({
      id,
      name: id,
      provider: "codex",
      projectId: project.id,
      worktreePath: `${project.path}/.worktrees/${id}`,
      branch: `agent/${id}`,
      sessionId: `session-${id}`,
      sessionKind: "pty",
      runtimeBinding: {
        schemaVersion: 1,
        runtime: "hmux_managed_v1",
        source: "local",
        hostId: "local",
        sessionId: `session-${id}`,
        workspaceId: `workspace-${id}`,
        createIdempotencyKey: `outline-${id}`,
      },
      started: true,
    }));

    state.setUiPrefs({
      theme: "dark",
      themeScheme: undefined,
      onboardingDismissed: true,
    });
    const desktopId = state.addDesktop({
      name: "Outline QA",
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
      language: "ko",
    });

    const api = await dock.waitForDesktopDockview(desktopId);
    if (!api) throw new Error("active desktop Dockview did not mount");
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
      referencePanel: "agent:outline-left",
      direction: "right",
    });
    addFixturePane(agents[2], {
      referencePanel: "agent:outline-right",
      direction: "below",
    });
    return { desktopId };
  });

  await page.waitForFunction(
    (desktopId) =>
      document
        .getElementById(`desktop-panel-${desktopId}`)
        ?.querySelectorAll(".dv-groupview:has([data-pane-title])").length === 3,
    fixture.desktopId,
    { timeout: 20_000 },
  );

  const shot = await page.screenshot({ animations: "disabled" });
  await writeFile(resolve(outputRoot, "00-dark-two-panes.png"), shot);

  const measurement = await page.evaluate(
    async ({ desktopId, dataUrl, cornerInset, gapMargin }) => {
      const card = document.getElementById(`desktop-panel-${desktopId}`);
      if (!card) throw new Error("pane card container is missing");
      const rect = card.getBoundingClientRect();
      const cardBox = {
        clientLeft: card.clientLeft,
        clientTop: card.clientTop,
        clientWidth: card.clientWidth,
        clientHeight: card.clientHeight,
        padding: getComputedStyle(card).padding,
        radius: getComputedStyle(card).borderRadius,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      };

      const image = new Image();
      await new Promise((done, fail) => {
        image.onload = done;
        image.onerror = () => fail(new Error("screenshot did not decode"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const at = (x, y) => {
        const index = (y * pixels.width + x) * 4;
        return [
          pixels.data[index],
          pixels.data[index + 1],
          pixels.data[index + 2],
        ];
      };

      // The outline occupies the card's outermost row/column.
      const left = Math.round(rect.left);
      const top = Math.round(rect.top);
      const right = Math.round(rect.right) - 1;
      const bottom = Math.round(rect.bottom) - 1;
      const walk = (from, to, sample) => {
        const colors = [];
        for (let step = from; step <= to; step += 1) colors.push(sample(step));
        return colors;
      };

      // The focused pane paints its own ring over its outer edges on purpose,
      // so both walks stay inside the pane that is NOT focused.
      const groups = Array.from(
        card.querySelectorAll(".dv-groupview:has([data-pane-title])"),
        (group) => {
          const box = group.getBoundingClientRect();
          return {
            title: group.querySelector("[data-pane-title]")?.textContent?.trim(),
            active: group.classList.contains("dv-active-group"),
            cardCorners: group.getAttribute("data-pane-card-corners"),
            radius: getComputedStyle(group).borderRadius,
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          };
        },
      ).sort((a, b) => a.left - b.left);
      const header = card
        .querySelector(".dv-tabs-and-actions-container")
        ?.getBoundingClientRect();
      if (groups.length !== 3) {
        return { card: { left, top, right, bottom }, groups, headerBottom: null };
      }

      // Layout: a full-height left column, and a right column split into two.
      // The focused pane is the nested bottom-right one, so a single pane
      // exercises both cases — a side edge that has to escape the inner split
      // container, and edges that land on the card boundary.
      const leftGroup = groups[0];
      const focused = groups.find((group) => group.active) ?? groups[1];
      const rightGroup = groups.find((group) => group !== leftGroup) ?? groups[1];
      const quiet = groups.find((group) => !group.active) ?? leftGroup;
      const gap = {
        from: Math.round(leftGroup.right),
        to: Math.round(rightGroup.left) - 1,
      };
      // Walk the gap plus the quiet pane's own stretch of the same edge: a
      // hole in the card outline shows up as the two disagreeing.
      const acrossGap = walk(gap.from - gapMargin, gap.to + gapMargin, (x) =>
        at(x, top),
      );
      // The card's left edge belongs to the unfocused column and runs past the
      // tab strip on down the body — one line, two surfaces behind it.
      const quietEdgeX = left;
      const downQuietEdge = walk(top + cornerInset, bottom - cornerInset, (y) =>
        at(quietEdgeX, y),
      );

      // Focus is a whole-pane statement, and the ring sits OUTSIDE the pane.
      const focusTop = Math.round(focused.top) + cornerInset;
      const focusBottom = Math.round(focused.bottom) - cornerInset;
      // Side edge: one pixel outside the pane, inside the 2px deck gap. For the
      // nested pane this pixel is outside its own split container.
      const focusedOuterX = Math.round(focused.left) - 1;
      const focusRing = walk(focusTop, focusBottom, (y) => at(focusedOuterX, y));
      const focusBody = walk(focusTop, focusBottom, (y) =>
        at(focusedOuterX + 2, y),
      );
      // Card-facing edge: the ring has to REPLACE the card outline there, not
      // stack a second line inside it. Grab a window spanning pane → shell.
      const cardEdgeWindows = [
        Math.round(focused.top) + 12,
        Math.round((focused.top + focused.bottom) / 2),
      ].map((y) =>
        walk(Math.round(focused.right) - 4, Math.round(focused.right) + 3, (x) =>
          at(x, y),
        ),
      );

      return {
        card: { left, top, right, bottom },
        cardBox,
        groups,
        gap,
        quiet: { title: quiet.title, edgeX: quietEdgeX },
        focused: { title: focused.title, outerEdgeX: focusedOuterX },
        headerBottom: header ? header.bottom : null,
        walks: { acrossGap, downQuietEdge, focusRing },
        focusBody,
        cardEdgeWindows,
      };
    },
    {
      desktopId: fixture.desktopId,
      dataUrl: `data:image/png;base64,${shot.toString("base64")}`,
      cornerInset: CORNER_INSET,
      gapMargin: GAP_MARGIN,
    },
  );

  assert.equal(measurement.groups.length, 3, "fixture must render three panes");
  assert.equal(
    measurement.groups.filter((group) => group.active).length,
    1,
    "exactly one pane must be focused, so the other one shows the bare outline",
  );
  assert.ok(
    measurement.gap.to >= measurement.gap.from,
    "the two panes must be separated by the deck gap this probe walks over",
  );
  assert.ok(
    measurement.headerBottom !== null &&
      measurement.headerBottom - measurement.card.top > 8 &&
      measurement.headerBottom < measurement.card.bottom - CORNER_INSET,
    "the tab strip must sit at the top of the card so the vertical walk crosses both surfaces",
  );

  // Every pane that reaches a card corner has to carry the card's rounding.
  // Miss the flag and that pane keeps the 2px inner radius, so the container's
  // 12px clip shaves its corner off (2026-08-11 user report).
  const CARD_CORNERS = ["tl", "tr", "bl", "br"];
  const flagged = new Set(
    measurement.groups.flatMap((group) => (group.cardCorners ?? "").split(" ")),
  );
  for (const corner of CARD_CORNERS) {
    assert.ok(
      flagged.has(corner),
      `no pane is marked as reaching the card's ${corner} corner: ${measurement.groups
        .map((g) => `${g.title}=${g.cardCorners ?? "-"}`)
        .join(", ")}`,
    );
  }
  for (const group of measurement.groups) {
    if (!group.cardCorners) continue;
    assert.ok(
      /\b11px\b/.test(group.radius),
      `${group.title} reaches the card (${group.cardCorners}) but rounds at ${group.radius}`,
    );
  }

  const report = {
    schemaVersion: 1,
    fixture: "pane-card-outline-visual",
    card: measurement.card,
    cardBox: measurement.cardBox,
    groups: measurement.groups,
    gap: measurement.gap,
    quiet: measurement.quiet,
    headerBottom: measurement.headerBottom,
    walks: {},
  };
  const walkColors = [];
  // Both walks report, so one broken invariant never hides the other.
  const broken = [];
  const claims = {
    // 1. The card is one card, so its outline does not stop at a pane seam.
    acrossGap:
      "the card outline is broken where two panes meet — the inter-pane gap punches a hole in it",
    // 2. The card is one outline, so it does not change color at the tab
    //    strip / pane body seam behind it.
    downQuietEdge:
      "the card outline changes color between the tab strip and the pane body",
    // 3. The focus ring is one ring around the focused pane, same color on
    //    the tab strip and the body.
    focusRing:
      "the focused pane's outside ring changes color between the tab strip and the pane body",
  };
  for (const [name, colors] of Object.entries(measurement.walks)) {
    const spread = channelSpread(colors);
    report.walks[name] = {
      samples: colors.length,
      spread,
      first: describe(colors[0]),
      darkest: describe(
        colors.reduce((a, b) => (a[0] + a[1] + a[2] <= b[0] + b[1] + b[2] ? a : b)),
      ),
      brightest: describe(
        colors.reduce((a, b) => (a[0] + a[1] + a[2] >= b[0] + b[1] + b[2] ? a : b)),
      ),
    };
    if (spread > EDGE_TOLERANCE) {
      broken.push(
        `${claims[name]}: spread ${spread} across ${colors.length} px (${report.walks[name].darkest} … ${report.walks[name].brightest})`,
      );
    }
    if (!name.startsWith("focus")) walkColors.push(colors[0]);
  }

  const crossSpread = channelSpread(walkColors);
  report.crossEdgeSpread = crossSpread;
  if (crossSpread > CROSS_EDGE_TOLERANCE) {
    broken.push(
      `card outline color differs between its top and side edges: spread ${crossSpread} (${walkColors.map(describe).join(", ")})`,
    );
  }

  // Focus has to be legible, not merely present: a ring the same value as the
  // pane behind it (or as the deck gap beside it) is what made the tab strip
  // tint look like the only focus cue.
  const ring = measurement.walks.focusRing[0];
  const body = measurement.focusBody[0];
  const gapColor = [46, 46, 46];
  report.focus = {
    ...measurement.focused,
    ring: describe(ring),
    body: describe(body),
    vsBody: channelSpread([ring, body]),
  };
  // On a card-facing edge the ring has to REPLACE the card outline, not stand
  // a second line inside it. Reported 2026-08-11: two parallel lines read as
  // "the focus line is on the inside".
  const outline = measurement.walks.downQuietEdge[0];
  const near = (a, b) => channelSpread([a, b]) <= CROSS_EDGE_TOLERANCE;
  report.focus.cardEdgeWindows = measurement.cardEdgeWindows.map((w) =>
    w.map(describe),
  );
  for (const [index, window] of measurement.cardEdgeWindows.entries()) {
    if (!window.some((pixel) => near(pixel, ring))) {
      broken.push(
        `the focused pane has no ring on the edge that touches the card (window ${index}: ${window.map(describe).join(" ")})`,
      );
    }
    if (window.some((pixel) => near(pixel, outline))) {
      broken.push(
        `the card outline still stands beside the focus ring on the card-facing edge — two parallel lines (window ${index}: ${window.map(describe).join(" ")})`,
      );
    }
  }
  // The ring replaces the card outline on card-facing edges, so it also has to
  // read against whatever the card sits on. It once matched the top chrome
  // almost exactly (rgb 91 vs 90) and the card's edge disappeared while
  // focused — worse than the outline it replaced (2026-08-11 user report).
  const outsideCard = measurement.cardEdgeWindows.map((w) => w.at(-1));
  report.focus.outsideCard = outsideCard.map(describe);
  for (const [what, against] of [
    ["the pane behind it", body],
    ["the deck gap beside it", gapColor],
    ...outsideCard.map((pixel) => ["what the card sits on", pixel]),
  ]) {
    const contrast = channelSpread([ring, against]);
    if (contrast < FOCUS_RING_MIN_CONTRAST) {
      broken.push(
        `the focused pane's ring does not read against ${what}: ${describe(ring)} vs ${describe(against)} (${contrast} < ${FOCUS_RING_MIN_CONTRAST})`,
      );
    }
  }
  report.broken = broken;
  await writeFile(
    resolve(outputRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  assert.deepEqual(broken, [], `pane card outline defects:\n- ${broken.join("\n- ")}`);

  assert.deepEqual(pageErrors, [], "fixture emitted uncaught page errors");

  const reportFile = resolve(outputRoot, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      output: relative(repoRoot, outputRoot),
      report: relative(repoRoot, reportFile),
    })}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
