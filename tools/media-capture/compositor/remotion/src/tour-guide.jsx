import React from "react";
import { tourPointerAt } from "../../tour-motion.mjs";

export function TourGuide({ input, ms, canvas }) {
  if (!input) return null;
  const pointer = tourPointerAt(input.events, ms);
  const scale = canvas.width / 1480;
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}>
    {input.events.filter((event) => event.kind === "down" && ms >= event.atMs && ms < event.atMs + 340).map((event, i) => {
      const progress = (ms - event.atMs) / 340;
      const radius = (9 + progress * 15) * scale;
      return <div key={i} style={{ position: "absolute", left: event.x * canvas.width - radius, top: event.y * canvas.height - radius, width: radius * 2, height: radius * 2, borderRadius: "50%", border: `${1.5 * scale}px solid #ffffff`, background: "#ffffff18", opacity: 1 - progress }} />;
    })}
    {pointer && <svg width={28 * scale} height={30 * scale} viewBox="0 0 28 30" style={{ position: "absolute", left: pointer.x * canvas.width - 3 * scale, top: pointer.y * canvas.height - 3 * scale, opacity: pointer.opacity, filter: `drop-shadow(0 ${2 * scale}px ${3 * scale}px #0006)` }}>
      <path d="M3 6 C2 3 4 2 7 3 L23 9 C26 10 26 13 23 14 L17 17 L14 24 C13 27 10 27 9 24 Z" fill="#171717" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    </svg>}
  </div>;
}
