import { describe, expect, it, vi } from "vitest";
import { resolveAgentRunAccount } from "../cli/lib/agent-run.mjs";
import { AppControlClientError } from "../cli/lib/app-control-client.mjs";
const descriptor={capabilities:["agent.launch_account_v1"]};
const profile={kind:"credential_reference",reference_id:"work",credential_generation:"generation-1"};
describe("Run account preference transport", () => {
  it("carries the exact account and backend and validates the returned generation", async () => {
    const requestClient=vi.fn(async () => ({ok:true,schemaVersion:1,executionProfile:profile}));
    expect(await resolveAgentRunAccount({descriptor,providerId:"claude",backendProfileId:"remote",account:"work",requestClient})).toEqual(profile);
    expect(requestClient).toHaveBeenCalledWith({descriptor,path:"/agent/launch-account",body:{providerId:"claude",backendProfileId:"remote",account:"work"}});
  });
  it.each([undefined, {capabilities:[]}])("supports old/headless clients with an explicit default policy", async (descriptor) => {
    expect(await resolveAgentRunAccount({descriptor,providerId:"claude"})).toEqual({kind:"provider_default"});
    await expect(resolveAgentRunAccount({descriptor,providerId:"claude",account:"work"})).rejects.toMatchObject({code:"client_account_unavailable"});
  });
  it.each([{kind:"provider_default"},{...profile,reference_id:"other"},{...profile,credential_generation:null},null])("does not silently change an explicit account: %j", async (executionProfile) => {
    await expect(resolveAgentRunAccount({descriptor,providerId:"claude",account:"work",requestClient:async () => ({ok:true,schemaVersion:1,executionProfile})})).rejects.toMatchObject({code:"client_account_response_invalid"});
  });
});
describe("Run account selection on the backend registry", () => {
  const backend={profile:{id:"local"},transportOptions:{}};
  const registered={schemaVersion:1,providerId:"codex",referenceId:"recovery-ref",credentialGeneration:"generation-2"};
  const requestBackend=vi.fn(async () => ({result:{schemaVersion:1,profiles:[registered],
    policy:{accounts:[{profile:registered,name:"Work"}]}}}));
  const unknownToApp=async () => { throw new AppControlClientError("agent_launch_account_unavailable","credential reference is unavailable for codex: recovery-ref"); };
  it("accepts a registered account the app does not list, as runs switch-account does", async () => {
    expect(await resolveAgentRunAccount({descriptor,providerId:"codex",backendProfileId:"local",account:"recovery-ref",
      backend,requestBackend,requestClient:unknownToApp})).toEqual({kind:"credential_reference",reference_id:"recovery-ref",credential_generation:"generation-2"});
    expect(requestBackend).toHaveBeenCalledWith(backend.profile,{operation:"provider_recovery.get",
      requiredCapabilities:["account_recovery.v1"],body:{schemaVersion:1,providerId:"codex"}},backend.transportOptions);
  });
  it("launches a registered account without a connected app", async () => {
    expect(await resolveAgentRunAccount({providerId:"codex",account:"recovery-ref",backend,requestBackend}))
      .toMatchObject({reference_id:"recovery-ref",credential_generation:"generation-2"});
  });
  it("lists usable account IDs when neither the app nor the backend has the account", async () => {
    const error=await resolveAgentRunAccount({descriptor,providerId:"codex",account:"sssky",backend,requestBackend,
      requestClient:unknownToApp}).catch((caught) => caught);
    expect(error).toMatchObject({code:"agent_launch_account_unavailable"});
    expect(error.message).toContain("recovery-ref (Work)");
    expect(error.message).toContain("dure recovery get codex --backend local");
  });
  it("does not mask an app connection failure", async () => {
    requestBackend.mockClear();
    await expect(resolveAgentRunAccount({descriptor,providerId:"codex",account:"recovery-ref",backend,requestBackend,
      requestClient:async () => { throw new AppControlClientError("client_unavailable","down"); }})).rejects.toMatchObject({code:"client_unavailable"});
    expect(requestBackend).not.toHaveBeenCalled();
  });
});
