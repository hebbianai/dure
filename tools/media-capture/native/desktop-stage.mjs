import { createHash } from "node:crypto";

export const NATIVE_DESKTOP_STAGE = Object.freeze({
  schemaVersion: 1,
  stageId: "dure-dusk-native-v1",
  mode: "generated-virtual-desktop",
  canvas: Object.freeze({ width: 1920, height: 1080 }),
  wallpaper: Object.freeze({
    kind: "linear-gradient",
    colors: Object.freeze(["#0b1020", "#2a1742", "#15233d"]),
    seed: 0,
    speed: 0,
    direction: Object.freeze({
      from: Object.freeze([0, 0]),
      to: Object.freeze([1920, 1080]),
    }),
  }),
  systemBar: Object.freeze({ height: 32, color: "#070a12", opacity: 0.7 }),
  dock: Object.freeze({
    width: 432,
    height: 52,
    bottom: 20,
    color: "#080b14",
    opacity: 0.6,
    iconSize: 36,
    iconGap: 12,
    iconColors: Object.freeze([
      "#a78bfa",
      "#60a5fa",
      "#34d399",
      "#fbbf24",
      "#fb7185",
      "#c084fc",
      "#94a3b8",
    ]),
    iconOpacity: 0.72,
  }),
  privacy: Object.freeze({
    desktopPixelsIncluded: false,
    source: "generated-filter-graph",
  }),
});

function validateTiming({ duration, fps }) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
    throw new Error("native desktop stage duration must be from 0 to 15 seconds");
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 15) {
    throw new Error("native desktop stage fps must be an integer from 1 to 15");
  }
}

function ffmpegColor(color) {
  return `0x${color.slice(1)}`;
}

export function nativeDesktopStageFilter({ duration, fps }) {
  validateTiming({ duration, fps });
  const { canvas, dock, systemBar, wallpaper } = NATIVE_DESKTOP_STAGE;
  const dockX = Math.round((canvas.width - dock.width) / 2);
  const dockY = canvas.height - dock.bottom - dock.height;
  const iconRowWidth =
    dock.iconColors.length * dock.iconSize +
    (dock.iconColors.length - 1) * dock.iconGap;
  const iconX = Math.round((canvas.width - iconRowWidth) / 2);
  const iconY = dockY + Math.round((dock.height - dock.iconSize) / 2);
  const wallpaperColors = wallpaper.colors
    .map((color, index) => `c${index}=${ffmpegColor(color)}`)
    .join(":");
  const layers = [
    `gradients=s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration}` +
      `:type=linear:x0=${wallpaper.direction.from[0]}` +
      `:y0=${wallpaper.direction.from[1]}:x1=${wallpaper.direction.to[0]}` +
      `:y1=${wallpaper.direction.to[1]}:${wallpaperColors}` +
      `:nb_colors=${wallpaper.colors.length}:seed=${wallpaper.seed}` +
      `:speed=${wallpaper.speed}`,
    `drawbox=x=0:y=0:w=iw:h=${systemBar.height}` +
      `:color=${ffmpegColor(systemBar.color)}@${systemBar.opacity}:t=fill`,
    `drawbox=x=${dockX}:y=${dockY}:w=${dock.width}:h=${dock.height}` +
      `:color=${ffmpegColor(dock.color)}@${dock.opacity}:t=fill`,
  ];
  dock.iconColors.forEach((color, index) => {
    layers.push(
      `drawbox=x=${iconX + index * (dock.iconSize + dock.iconGap)}` +
        `:y=${iconY}:w=${dock.iconSize}:h=${dock.iconSize}` +
        `:color=${ffmpegColor(color)}@${dock.iconOpacity}:t=fill`,
    );
  });
  return `${layers.join(",")}[canvas]`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function nativeDesktopStageManifest({ fps, frameCount }) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 225) {
    throw new Error("native desktop stage frameCount must be from 1 to 225");
  }
  validateTiming({ duration: 1, fps });
  const duration = frameCount / fps;
  const frameFilter = nativeDesktopStageFilter({ duration: 1, fps: 1 });
  return {
    ...NATIVE_DESKTOP_STAGE,
    render: {
      engine: "ffmpeg-filter-graph",
      fps,
      frameCount,
      durationMs: Math.round(duration * 1_000),
      composition: "independent-full-frame-sequence",
      frameRecipeSha256: sha256(frameFilter),
    },
  };
}
