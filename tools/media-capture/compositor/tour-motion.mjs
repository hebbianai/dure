const clamp = (n) => Math.max(0, Math.min(1, n));

export function validateTourInput(input, durationMs) {
  if (input?.schemaVersion !== 1 || !Number.isInteger(input.number) || input.number < 1 || input.number > 6 ||
      ![input.title, input.intro].every((text) => typeof text === "string" && text.length > 0 && text.length < 180) ||
      !Array.isArray(input.events) || !input.events.length) throw new Error("Invalid recorded tour input");
  let previous = -1;
  for (const event of input.events) {
    if (!Number.isFinite(event.atMs) || event.atMs < previous || event.atMs < 0 || event.atMs > durationMs ||
        !["move", "down", "up", "key", "caption"].includes(event.kind)) throw new Error("Invalid recorded tour event");
    if (["move", "down", "up"].includes(event.kind)) {
      if (![event.x, event.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid recorded tour point");
    } else if (typeof event.text !== "string" || !event.text || event.text.length > 180) throw new Error("Invalid recorded tour text");
    previous = event.atMs;
  }
  return input;
}

export function tourPointerAt(events, ms) {
  const points = events.filter((event) => ["move", "down", "up"].includes(event.kind))
    .filter((point, i, all) => i === 0 || point.kind !== "move" || point.x !== all[i - 1].x || point.y !== all[i - 1].y);
  if (!points.length || ms < points[0].atMs - 120) return null;
  let current = points[0];
  for (const next of points.slice(1)) {
    if (ms >= next.atMs) { current = next; continue; }
    const start = Math.max(current.atMs, next.atMs - 260);
    const t = clamp((ms - start) / Math.max(1, next.atMs - start));
    const held = events.filter((event) => ["down", "up"].includes(event.kind) && event.atMs <= start).at(-1)?.kind === "down";
    const eased = held ? t : t * t * (3 - 2 * t);
    return { x: current.x + (next.x - current.x) * eased, y: current.y + (next.y - current.y) * eased, opacity: 1 };
  }
  return { ...current, opacity: 1 - clamp((ms - current.atMs - 1000) / 250) };
}
