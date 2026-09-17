import { PRODUCT_TOUR_STORYBOARD } from "./storyboards/product-tour.mjs";
import { SOCIAL_PANE_LAYOUT_STORYBOARD } from "./storyboards/social-pane-layout.mjs";
import { assertValidStoryboard } from "./schema.mjs";
import { ONBOARDING_LAUNCH_STORYBOARD } from "./storyboards/onboarding-launch.mjs";
import { WORKSPACE_OVERVIEW_TOUR_STORYBOARD } from "./storyboards/workspace-overview-tour.mjs";
import { WORKSPACE_LIFECYCLE_PROOF_STORYBOARD } from "./storyboards/workspace-lifecycle-proof.mjs";

export const MEDIA_STORYBOARDS = Object.freeze(
  [
    ONBOARDING_LAUNCH_STORYBOARD,
    PRODUCT_TOUR_STORYBOARD,
    SOCIAL_PANE_LAYOUT_STORYBOARD,
    WORKSPACE_OVERVIEW_TOUR_STORYBOARD,
    WORKSPACE_LIFECYCLE_PROOF_STORYBOARD,
  ].map(assertValidStoryboard),
);

export function storyboardById(id) {
  const storyboard = MEDIA_STORYBOARDS.find((candidate) => candidate.id === id);
  if (!storyboard) throw new Error(`unknown storyboard ${id}`);
  return storyboard;
}
