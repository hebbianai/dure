import { captureProofRequirements } from "./capture-proof.mjs";

export function assertBrowserCaptureProviderSource(options, scenario) {
  const requirements = captureProofRequirements(scenario);
  if (
    requirements.requiredProviderSource !== null &&
    options.providerSource !== requirements.requiredProviderSource
  ) {
    throw new Error(
      `${scenario.id} requires --provider-source ${requirements.requiredProviderSource} for ${requirements.profile}`,
    );
  }
}
