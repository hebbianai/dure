import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserViewerRequest } from "./browser-viewer-channel.mjs";

export async function proveBrowserViewer({ command, identity, artifacts }) {
  async function waitReport(predicate) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const reports = await browserViewerRequest("/reports");
      const error = reports.find((report) => report.type === "error");
      if (error) throw new Error(error.message);
      const report = reports.find(predicate);
      if (report) return report;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("timed out waiting for WKWebView browser evidence");
  }
  async function capture(revision, name) {
    await browserViewerRequest("/configuration", {
      revision,
      action: "capture",
    });
    const result = await waitReport(
      (report) => report.type === "capture" && report.revision === revision,
    );
    assert.match(result.userAgent, /AppleWebKit/u);
    assert.doesNotMatch(result.userAgent, /Chrom(?:e|ium)/u);
    assert.ok(result.png.startsWith("data:image/png;base64,"));
    await writeFile(
      join(artifacts, name),
      Buffer.from(result.png.split(",")[1], "base64"),
    );
    const { png, ...metadata } = result;
    return metadata;
  }
  const before = await capture(1, "wkwebview-before.png");
  await command("a", ["fill", 'input[aria-label="Name"]', ""]);
  await command("a", ["focus", 'input[aria-label="Name"]']);
  await browserViewerRequest("/configuration", {
    revision: 2,
    action: "compose",
    text: "한글 조합 검증",
  });
  const composition = await waitReport(
    (report) => report.type === "composed" && report.revision === 2,
  );
  await writeFile(
    join(artifacts, "wkwebview-composition.json"),
    JSON.stringify(composition, null, 2),
  );
  assert.deepEqual(composition.committedText, ["한글 조합 검증"]);
  // Carry the actual viewer commit through the native text operation. Stream
  // keyboard char events are keystrokes, not the bulk/IME text insertion API.
  await command("a", ["keyboard", "inserttext", composition.committedText[0]]);
  try {
    await command("a", [
      "wait",
      "--fn",
      'document.querySelector("input").value === "한글 조합 검증"',
    ]);
  } catch (error) {
    const actual = await command("a", [
      "eval",
      '({value:document.querySelector("input").value,active:document.activeElement?.outerHTML})',
    ]);
    await writeFile(
      join(artifacts, "wkwebview-composition-failure.json"),
      JSON.stringify(actual, null, 2),
    );
    throw new Error(`${error.message}; actual ${JSON.stringify(actual.data)}`);
  }
  const after = await capture(3, "wkwebview-after.png");
  await browserViewerRequest("/configuration", {
    revision: 4,
    action: "reconnect",
  });
  await waitReport(
    (report) => report.type === "frame" && report.revision === 4,
  );
  const reconnected = await capture(5, "wkwebview-reconnected.png");
  assert.equal(
    (await command("a", ["eval", "window.fixture.instance"])).data.result,
    identity,
  );
  return {
    before,
    composition,
    after,
    reconnected,
    limitation:
      "Synthetic composition events, not physical OS IME input; authenticated QA frame/text relay, not the product Host.",
  };
}
