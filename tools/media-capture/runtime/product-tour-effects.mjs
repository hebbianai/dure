// Keep presentation out of the source pixels; the compositor draws input at 60 fps.
export async function installProductTourEffects(page, guide) {
  await page.evaluate((guide) => {
    const { title, intro, number } = guide;
    const input = { schemaVersion: 1, title, intro, number, events: [] };
    window.__DURE_TOUR_INPUT__ = input;
    const record = (event) => input.events.push({ atMs: performance.timeOrigin + performance.now(), ...event });
    for (const type of ["mousemove", "mousedown", "mouseup", "dragover"]) {
      window.addEventListener(type, (event) => record({
        kind: type === "mousedown" ? "down" : type === "mouseup" ? "up" : "move",
        x: event.clientX / innerWidth, y: event.clientY / innerHeight,
      }), true);
    }
    window.addEventListener("keydown", (event) => {
      if (event.metaKey && !["Meta", "Shift", "Control", "Alt"].includes(event.key)) {
        record({ kind: "key", text: `⌘ ${event.key.toUpperCase()}` });
      }
    }, true);
  }, guide);
}

export async function setProductTourCaption(page, text) {
  if (text) await page.evaluate((text) => window.__DURE_TOUR_INPUT__.events.push({
    kind: "caption", text, atMs: performance.timeOrigin + performance.now(),
  }), text);
}

export async function recordedProductTourInput(page, firstTimestamp, duration) {
  return page.evaluate(({ firstTimestamp, duration }) => {
    const input = window.__DURE_TOUR_INPUT__;
    if (!input) return null;
    return { ...input, events: input.events
      .map((event) => ({ ...event, atMs: Math.round(event.atMs - firstTimestamp * 1000) }))
      .filter((event) => event.atMs >= 0 && event.atMs <= duration * 1000) };
  }, { firstTimestamp, duration });
}
