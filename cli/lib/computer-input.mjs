// One input transaction, also executed inside osascript's JavaScript runtime.
// Keep this function self-contained so fixtures exercise the exact native flow.
export function performComputerInput(request, desktop) {
  var inputAttempted = false;
  function refuse(code, message) {
    var error = new Error(message);
    error.code = code;
    throw error;
  }
  function requireTarget(target, observation) {
    if (!observation || observation.pid !== target.pid || observation.generation !== target.generation) {
      refuse("computer_target_changed", "The selected app exited or its process changed.");
    }
    return observation;
  }
  function requireFocus(target) {
    var observation = requireTarget(target, desktop.observe(target.pid));
    if (observation.frontmostPid !== target.pid) {
      refuse("computer_focus_changed", "The selected app no longer has keyboard focus.");
    }
  }
  try {
    var candidates = desktop.resolve(request);
    if (candidates.length === 0) {
      refuse("computer_app_not_running", "No running app matches the target. Open it first, then retry.");
    }
    if (candidates.length !== 1) {
      refuse("computer_app_ambiguous", "Several running apps match. Select one with --pid: " + candidates.map(function (app) { return app.pid; }).join(", ") + ".");
    }
    var target = candidates[0];
    if (!target.generation) refuse("computer_identity_unavailable", "The app's process identity could not be verified.");
    requireTarget(target, desktop.observe(target.pid));
    var deadline = desktop.now() + 5000;
    if (!desktop.activate(target)) {
      refuse("computer_activation_failed", "macOS refused to activate the selected app.");
    }
    while (true) {
      var observation = requireTarget(target, desktop.observe(target.pid));
      if (desktop.now() >= deadline) {
        refuse("computer_activation_timeout", "The selected app did not become active within 5 seconds.");
      }
      if (observation.frontmostPid === target.pid) break;
      desktop.wait(Math.max(0, Math.min(50, deadline - desktop.now())));
    }
    requireFocus(target);
    if (request.sub !== "activate") {
      // The native adapter addresses events to this PID and repeats this
      // identity/focus check between characters. Observation is not atomic.
      desktop.send(request, target, function () {
        requireFocus(target);
        inputAttempted = true;
      });
      requireFocus(target);
    }
    return { ok: true, pid: target.pid, action: request.sub, inputAttempted: inputAttempted };
  } catch (error) {
    var code = error.code || "computer_native_error";
    if (inputAttempted) code = "computer_input_unconfirmed";
    return {
      ok: false,
      error: {
        code: code,
        message: inputAttempted
          ? "Input may already have been sent. Re-observe the app before retrying. " + String(error.message || error)
          : String(error.message || error),
        inputMayHaveBeenSent: inputAttempted,
      },
    };
  }
}
