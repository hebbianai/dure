import {
  loadBackendProfiles,
  selectBackendProfile,
} from "./backend-profiles.mjs";
import { resolveBackendSshReferencesFromEnvironment } from "./backend-ssh-references.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";

const PREFIX = "backend-profile:";

export async function requestOrchestrationThroughBackendProfile(
  endpoint,
  request,
  {
    environment = process.env,
    performRequest = performBackendProfileRequest,
    signal,
  } = {},
) {
  if (typeof endpoint !== "string" || !endpoint.startsWith(PREFIX)) {
    throw new Error("orchestration backend profile endpoint is invalid");
  }
  const explicitId = endpoint.slice(PREFIX.length) || undefined;
  const selection = selectBackendProfile(loadBackendProfiles({ environment }), {
    explicitId,
    environment,
  });
  const response = await performRequest(
    selection.profile,
    {
      operation: "orchestration.invoke",
      body: request,
      requiredCapabilities: ["orchestration.invoke",
        ...(request.method === "interaction.progress" ? ["orchestration.interaction.progress_v1"] : []),
      ],
    },
    {
      maxResponseBytes: 2 * 1024 * 1024,
      resolveSshReferences: (references) =>
        resolveBackendSshReferencesFromEnvironment(references, environment),
      signal,
    },
  );
  return response.result;
}
