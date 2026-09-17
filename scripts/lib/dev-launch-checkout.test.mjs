import { expect, it, vi } from "vitest";
import { prepareDevLaunchCheckout } from "./dev-launch-checkout.mjs";

it("admits a child replacement without requiring parent handoff capabilities", async () => {
  const observe = vi.fn(async () => ({ state: "ready" }));
  const inspect = vi.fn();
  await expect(
    prepareDevLaunchCheckout(
      { kind: "child_restart" },
      {
        observe,
        inspect,
      },
    ),
  ).resolves.toEqual({ admitted: true });
  expect(observe.mock.calls[0][0]).not.toHaveProperty(
    "requireParentReloadAuthority",
  );
  expect(inspect).not.toHaveBeenCalled();
});

it.each(["parent_reload", "child_restart"])(
  "keeps %s checkout unchanged when its control owner is unavailable",
  async (kind) => {
    const restart = vi.fn();
    const result = await prepareDevLaunchCheckout(
      { kind },
      {
        observe: async () => {
          throw new Error("control socket is missing");
        },
        observeRestart: async () => {
          throw new Error("control socket is missing");
        },
        restart,
      },
    );
    expect(result).toMatchObject({
      admitted: false,
      transition: {
        kind,
        state: "not_started",
        attempted: false,
        destructiveBoundaryCrossed: false,
        relaunchDispatched: false,
        reason: expect.stringContaining("control socket is missing"),
      },
    });
    expect(restart).not.toHaveBeenCalled();
  },
);
