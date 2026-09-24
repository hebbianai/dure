import { describe, expect, it, vi } from "vitest";
import { resolveAgentRunAccount } from "../cli/lib/agent-run.mjs";
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
