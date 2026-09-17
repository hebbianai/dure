import React from "react";
import { Composition } from "remotion";
import { StoryboardComposition } from "./storyboard-composition.jsx";

const defaultProps = {
  canvas: {
    width: 1_920,
    height: 1_080,
    safeArea: { top: 72, right: 96, bottom: 88, left: 96 },
    background: "#181818",
  },
  locale: "en",
  target: {
    width: 1_920,
    height: 1_080,
    fps: 25,
    durationInFrames: 1,
  },
  sources: [],
  shots: [],
  reviewKeyframes: [],
  renderPlanSha256: "unconfigured",
};

export const RemotionRoot = () => (
  <Composition
    id="DureStoryboard"
    component={StoryboardComposition}
    durationInFrames={1}
    fps={25}
    width={1_920}
    height={1_080}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.target.durationInFrames,
      fps: props.target.fps,
      width: props.target.width,
      height: props.target.height,
    })}
  />
);
