import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_OPACITY,
  MAX_SHELL_CHROMA_GAIN,
  shellChromaGain,
} from "./shellOpacity";

describe("shellOpacity", () => {
  it("gain is the reciprocal of the alpha", () => {
    // Dark keeps the pre-preference constant (2) so the default look never
    // shifts; light moved to 80% on 2026-09-08 and to 70% on 2026-09-13, and
    // its gain follows the alpha either way.
    expect(shellChromaGain(DEFAULT_SHELL_OPACITY.dark)).toBe(2);
    expect(shellChromaGain(DEFAULT_SHELL_OPACITY.light)).toBeCloseTo(
      100 / DEFAULT_SHELL_OPACITY.light,
      10,
    );
    expect(shellChromaGain(100)).toBe(1);
    expect(shellChromaGain(25)).toBe(4);
    // Alpha 0 must stay finite; beyond the gamut clamp the cap is lossless.
    expect(shellChromaGain(0)).toBe(MAX_SHELL_CHROMA_GAIN);
    expect(shellChromaGain(1)).toBe(MAX_SHELL_CHROMA_GAIN);
  });
});
