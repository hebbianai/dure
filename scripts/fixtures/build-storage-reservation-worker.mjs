import { reserveBuildStorage } from "../lib/build-storage-reservation.mjs";

const [cwd, reservationRoot] = process.argv.slice(2);

function observeProcesses(pids) {
  const requestedPids = [...new Set(pids)].sort((left, right) => left - right);
  return {
    status: "complete",
    scope: { kind: "point", requestedPids },
    members: requestedPids.map((pid) => ({
      pid,
      processIdentity: `fixture:${pid}`,
      state: "live",
    })),
  };
}

process.send?.({ ready: true });
process.once("message", (message) => {
  if (message?.start !== true) process.exit(2);
  try {
    const result = reserveBuildStorage({
      availableBytes: 100,
      cwd,
      floorBytes: 20,
      label: "concurrent fixture",
      observeProcesses,
      ownerIdentity: `fixture:${process.pid}`,
      requestedBytes: 50,
      reservationRoot,
    });
    const release = () => {
      result.reservation?.release();
      process.exit(0);
    };
    process.once("disconnect", release);
    process.once("message", (message) => {
      if (message?.release !== true) process.exit(2);
      release();
    });
    process.send?.({
      ok: result.ok,
      reason: result.reason,
      invalid: result.invalid,
    });
  } catch (error) {
    process.send?.({ error: error.message, ok: false });
    process.exit(1);
  }
});
