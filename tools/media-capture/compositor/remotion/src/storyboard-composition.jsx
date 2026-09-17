import React from "react";
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { TourGuide } from "./tour-guide.jsx";
import { absoluteRectStyle } from "./layout.mjs";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const captionTones = Object.freeze({
  neutral: Object.freeze({ color: "#f5f5f5", border: "rgba(255,255,255,0.16)" }),
  observed: Object.freeze({ color: "#c8dcf4", border: "rgba(154,190,232,0.42)" }),
  replay: Object.freeze({ color: "#d8cdee", border: "rgba(190,168,222,0.4)" }),
});

function fadeOpacity(frame, startFrame, endFrame) {
  const fadeFrames = Math.min(6, Math.max(1, Math.floor((endFrame - startFrame) / 3)));
  return Math.min(
    interpolate(frame, [startFrame, startFrame + fadeFrames], [0, 1], clamp),
    interpolate(frame, [endFrame - fadeFrames, endFrame], [1, 0], clamp),
  );
}

function Caption({ caption, frame }) {
  if (!caption || frame < caption.startFrame || frame >= caption.endFrame) return null;
  const tone = captionTones[caption.tone ?? "neutral"];
  return (
    <div
      style={{
        ...absoluteRectStyle(caption.rect),
        position: "absolute",
        display: "flex",
        alignItems: "center",
        padding: "0 28px",
        border: `1px solid ${tone.border}`,
        borderRadius: 18,
        background: "rgba(16,16,16,0.86)",
        boxShadow: "0 12px 38px rgba(0,0,0,0.36)",
        color: tone.color,
        fontFamily: '"Geist Variable", Inter, system-ui, sans-serif',
        fontSize: 34,
        fontWeight: 590,
        letterSpacing: "-0.02em",
        opacity: fadeOpacity(frame, caption.startFrame, caption.endFrame),
        zIndex: 2,
      }}
    >
      {caption.text}
    </div>
  );
}

function Callout({ callout, frame, canvas }) {
  if (frame < callout.startFrame || frame >= callout.endFrame) return null;
  const opacity = fadeOpacity(frame, callout.startFrame, callout.endFrame);
  const target = {
    x: callout.target.x * canvas.width,
    y: callout.target.y * canvas.height,
    width: callout.target.width * canvas.width,
    height: callout.target.height * canvas.height,
  };
  const from = {
    x: callout.labelRect.x + callout.labelRect.width / 2,
    y: callout.labelRect.y + callout.labelRect.height / 2,
  };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  return (
    <>
      <svg
        aria-hidden="true"
        width={canvas.width}
        height={canvas.height}
        style={{ position: "absolute", inset: 0, opacity, zIndex: 1 }}
      >
        <line
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          stroke="#f6a623"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="10 10"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          ...absoluteRectStyle(target),
          border: "4px solid #f6a623",
          borderRadius: 18,
          boxShadow: "0 0 0 7px rgba(246,166,35,0.17)",
          opacity,
          zIndex: 1,
        }}
      />
      <div
        style={{
          position: "absolute",
          ...absoluteRectStyle(callout.labelRect),
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          border: "1px solid rgba(246,166,35,0.52)",
          borderRadius: 15,
          background: "rgba(28,24,18,0.94)",
          color: "#ffd48a",
          fontFamily: '"Geist Variable", Inter, system-ui, sans-serif',
          fontSize: 26,
          fontWeight: 560,
          lineHeight: 1.2,
          opacity,
          zIndex: 1,
        }}
      >
        {callout.text}
      </div>
    </>
  );
}

function Shot({ shot, source, frame, canvas, fps }) {
  const localFrame = frame - shot.startFrame;
  const zoom = interpolate(
    localFrame,
    [0, Math.max(1, shot.durationInFrames - 1)],
    [shot.zoom.from, shot.zoom.to],
    clamp,
  );
  const crop = shot.crop;
  return (
    <AbsoluteFill
      style={{ overflow: "hidden", background: canvas.background, isolation: "isolate" }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          transform: `scale(${zoom})`,
          transformOrigin: `${shot.zoom.anchor.x * 100}% ${shot.zoom.anchor.y * 100}%`,
          zIndex: 0,
        }}
      >
        <OffthreadVideo
          muted
          src={staticFile(source.capturePath)}
          trimBefore={shot.sourceStartFrame}
          trimAfter={shot.sourceEndFrame}
          style={{
            position: "absolute",
            width: `${100 / crop.width}%`,
            height: `${100 / crop.height}%`,
            left: `${(-crop.x * 100) / crop.width}%`,
            top: `${(-crop.y * 100) / crop.height}%`,
            objectFit: "fill",
          }}
        />
      </div>
      <TourGuide input={source.input} ms={shot.sourceStartMs + localFrame * 1000 / fps} canvas={canvas} />
      <Caption caption={shot.caption} frame={frame} />
      {shot.callouts.map((callout) => (
        <Callout
          key={`${shot.id}-${callout.startFrame}-${callout.text}`}
          callout={callout}
          frame={frame}
          canvas={canvas}
        />
      ))}
    </AbsoluteFill>
  );
}

export function StoryboardComposition({ canvas, target, sources, shots }) {
  const frame = useCurrentFrame();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const scale = target.width / canvas.width;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: canvas.background }}>
      <div
        style={{
          position: "absolute",
          width: canvas.width,
          height: canvas.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {shots.map((shot) => (
          <Sequence
            key={shot.id}
            from={shot.startFrame}
            durationInFrames={shot.durationInFrames}
            premountFor={Math.min(target.fps, shot.durationInFrames)}
          >
            <Shot
              shot={shot}
              source={sourceById.get(shot.sourceId)}
              frame={frame}
              canvas={canvas}
              fps={target.fps}
            />
          </Sequence>
        ))}
      </div>
    </AbsoluteFill>
  );
}
