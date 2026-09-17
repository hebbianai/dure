export async function runClipboardImagePasteAction(page, action, runtime = {}) {
  if (action.action !== "pasteClipboardImage") return false;
  if (runtime.measureOnly) return true;

  const expected = await page.evaluate(({ agentId, desktopId }) => {
    const fixture = window.__DURE_MEDIA_CAPTURE_CONFIG__.fixture;
    const contract = fixture.clipboardImagePaste;
    if (!contract || contract.agentId !== agentId) {
      throw new Error(`capture image-paste fixture is missing: ${agentId}`);
    }
    const api = window.__DURE_DOCK__.getDockview(desktopId);
    const panel = api?.getPanel(`agent:${agentId}`);
    const host = panel?.group?.element?.querySelector?.(".terminal-host");
    if (!host) {
      throw new Error(`capture image-paste terminal is missing: ${agentId}`);
    }
    const transfer = new DataTransfer();
    host.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
    return {
      remotePath: contract.remotePath,
      sessionId: contract.sessionId,
    };
  }, action);

  await page.waitForFunction(
    ({ remotePath, sessionId }) => {
      const receipt = window.__DURE_MEDIA_CAPTURE_MOCK__.diagnostics()
        .clipboardImagePaste;
      return (
        receipt.uploads.some(
          (upload) =>
            upload.sessionId === sessionId &&
            upload.remotePath === remotePath,
        ) &&
        receipt.writes.some(
          (write) =>
            write.sessionId === sessionId && write.data === `${remotePath} `,
        )
      );
    },
    expected,
  );
  await page.evaluate((sessionId) => {
    window.__DURE_MEDIA_CAPTURE_MOCK__.repaintTerminal(sessionId, "ssh");
  }, expected.sessionId);
  await page.waitForFunction(
    (remotePath) => document.body.innerText.includes(remotePath),
    expected.remotePath,
  );
  return true;
}
