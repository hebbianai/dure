// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffReviewCapabilities } from "@/components/scm/useDiffReviewCapabilities";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function Harness({ cwds }: { readonly cwds: readonly string[] }) {
  const { capabilities } = useDiffReviewCapabilities(cwds);
  return (
    <output data-testid="capabilities">
      {JSON.stringify([...capabilities.entries()])}
    </output>
  );
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("useDiffReviewCapabilities", () => {
  it("publishes exact-cwd Git and non-Git outcomes", async () => {
    invokeMock.mockImplementation(
      async (_command: string, input: { path: string }) =>
        input.path === "/hook/repo-one/subdir"
          ? { code: 0, stdout: "/hook/repo-one\n", stderr: "" }
          : { code: 128, stdout: "", stderr: "not a repository" },
    );

    render(<Harness cwds={["/hook/repo-one/subdir", "/hook/non-repo-one"]} />);

    await waitFor(() => {
      expect(screen.getByTestId("capabilities").textContent).toBe(
        JSON.stringify([
          [
            "/hook/repo-one/subdir",
            { status: "available", worktreePath: "/hook/repo-one" },
          ],
          ["/hook/non-repo-one", { status: "unavailable" }],
        ]),
      );
    });
    expect(invokeMock).toHaveBeenCalledWith("git_exec", {
      path: "/hook/repo-one/subdir",
      args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    });
  });

  it("does not publish a late result after the observed cwd changes", async () => {
    let resolveOld:
      | ((value: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    invokeMock.mockImplementation(
      (_command: string, input: { path: string }) => {
        if (input.path === "/hook/old-two") {
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve({
          code: 128,
          stdout: "",
          stderr: "not a repository",
        });
      },
    );

    const view = render(<Harness cwds={["/hook/old-two"]} />);
    view.rerender(<Harness cwds={["/hook/new-two"]} />);

    await waitFor(() => {
      expect(screen.getByTestId("capabilities").textContent).toBe(
        JSON.stringify([["/hook/new-two", { status: "unavailable" }]]),
      );
    });

    await act(async () => {
      resolveOld?.({
        code: 0,
        stdout: "/hook/old-two\n",
        stderr: "",
      });
    });

    expect(screen.getByTestId("capabilities").textContent).toBe(
      JSON.stringify([["/hook/new-two", { status: "unavailable" }]]),
    );
  });
});
