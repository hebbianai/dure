import { describe, expect, it } from "vitest";
import { BackendProfileError } from "../cli/lib/backend-profiles.mjs";
import { backendRequestFailure } from "../cli/lib/backend-request-failure.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { LocalBackendError } from "../cli/lib/local-backend.mjs";

describe("backend request failure projection", () => {
  it.each([
    ["recovering", { status: "recovering", retryable: true }],
    [
      "cli_update_required",
      {
        status: "cli_update_required",
        retryable: false,
        action: {
          label: "Update Dure App",
          command: "dure install --global",
        },
      },
    ],
  ])("projects canonical local backend receipt %s", (code, lifecycle) => {
    expect(backendRequestFailure(new LocalBackendError(code))).toMatchObject({
      code,
      ...lifecycle,
    });
  });

  it("preserves non-lifecycle local backend errors without inventing a receipt", () => {
    const failure = backendRequestFailure(
      new LocalBackendError("local_backend_descriptor_invalid"),
    );
    expect(failure).toMatchObject({ code: "local_backend_descriptor_invalid" });
    expect(failure).not.toHaveProperty("status");
    expect(failure).not.toHaveProperty("retryable");
    expect(failure).not.toHaveProperty("action");
  });

  it("preserves exact backend profile errors", () => {
    expect(
      backendRequestFailure(
        new BackendProfileError("backend_profiles_selection_not_found"),
      ),
    ).toMatchObject({ code: "backend_profiles_selection_not_found" });
  });

  it("preserves validated remote transport details", () => {
    expect(
      backendRequestFailure(
        new BackendTransportError("backend_transport_remote_error", {
          details: { code: "remote_busy", disposition: "retry_same" },
        }),
        { id: "remote-a", transport: { kind: "ssh" } },
      ),
    ).toMatchObject({
      code: "backend_transport_remote_error",
      remoteCode: "remote_busy",
      disposition: "retry_same",
    });
  });

  it("fails closed for an untyped error", () => {
    expect(backendRequestFailure(new Error("untyped"))).toMatchObject({
      code: "backend_transport_unavailable",
    });
  });
});
