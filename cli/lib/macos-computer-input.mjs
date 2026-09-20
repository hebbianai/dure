import { spawnSync } from "node:child_process";
import { performComputerInput } from "./computer-input.mjs";

// This adapter runs in JXA, not Node. No target is launched or resolved again by
// name after selection. NSRunningApplication.launchDate can be nil, so use the
// same kernel process unique ID as scripts/native/owned-process-observer.c.
export function createMacComputerDesktop() {
  ObjC.import("AppKit");
  ObjC.import("ApplicationServices");
  ObjC.import("Carbon");
  ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "uint64_t", "void *", "int"]]);
  // NSData.bytes is void*. Bind explicitly to avoid JXA's incompatible Ref
  // conversion for the framework's const UniChar* declaration.
  ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
  ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]);
  ObjC.bindFunction("CGEventPostToPid", ["void", ["int", "void *"]]);
  ObjC.bindFunction("CFDataGetBytePtr", ["void *", ["void *"]]);
  ObjC.bindFunction("UCKeyTranslate", ["int", ["void *", "unsigned short", "unsigned short", "unsigned int", "unsigned int", "unsigned int", "void *", "unsigned long", "void *", "void *"]]);
  var events = Application("System Events");
  function keyForCharacter(character) {
    // Resolve against the current ASCII-capable layout, including punctuation
    // modifiers. Do not assume ANSI/US key positions or switch the user's IME.
    var source = $.TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
    var layout = $.TISGetInputSourceProperty(source, $.kTISPropertyUnicodeKeyLayoutData);
    var data = $.CFDataGetBytePtr(layout);
    var shifts = [0, 2, 8, 10]; // Carbon shift/option bits, after >> 8.
    for (var shiftIndex = 0; shiftIndex < shifts.length; shiftIndex++) {
      for (var code = 0; code < 128; code++) {
        var dead = $.NSMutableData.dataWithLength(4);
        var length = $.NSMutableData.dataWithLength(8);
        var output = $.NSMutableData.dataWithLength(8);
        var status = $.UCKeyTranslate(data, code, 0, shifts[shiftIndex], $.LMGetKbdType(), 1, dead.mutableBytes, 4, length.mutableBytes, output.mutableBytes);
        var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(output, $.NSUTF16LittleEndianStringEncoding));
        if (status === 0 && text && text.replace(/\u0000+$/, "") === character) {
          return { code: code, flags: (shifts[shiftIndex] & 2 ? 131072 : 0) | (shifts[shiftIndex] & 8 ? 524288 : 0) };
        }
      }
    }
    throw new Error("The key is unavailable in the current keyboard layout. Use type for Unicode text.");
  }
  function postKey(target, code, flags, character, checkFocus) {
    var source = $.CGEventSourceCreate(-1); // Private state: do not inherit held modifiers.
    var down = $.CGEventCreateKeyboardEvent(source, code, true);
    var up = $.CGEventCreateKeyboardEvent(source, code, false);
    $.CGEventSetFlags(down, flags);
    $.CGEventSetFlags(up, flags);
    if (character !== undefined) {
      var bytes = $(character).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
      $.CGEventKeyboardSetUnicodeString(down, character.length, bytes.bytes);
      $.CGEventKeyboardSetUnicodeString(up, character.length, bytes.bytes);
    }
    checkFocus();
    $.CGEventPostToPid(target.pid, down);
    $.CGEventPostToPid(target.pid, up);
  }
  function snapshot(pid) {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (app.isNil() || app.terminated) return null;
    var bytes = $.NSMutableData.dataWithLength(56);
    if ($.proc_pidinfo(pid, 17, 0, bytes.mutableBytes, 56) !== 56) return null;
    var identity = ObjC.unwrap(bytes.subdataWithRange($.NSMakeRange(16, 8)).base64EncodedStringWithOptions(0));
    if (!identity || identity === "AAAAAAAAAAA=") return null;
    return { pid: Number(pid), generation: identity };
  }
  return {
    resolve: function (request) {
      var pids = request.pid !== undefined
        ? [request.pid]
        : events.applicationProcesses.whose({ name: request.app }).unixId();
      // Do not collapse an ambiguous name to one candidate just because one
      // process could not be inspected or exited during enumeration.
      if (request.pid !== undefined) {
        var selected = snapshot(request.pid);
        return selected ? [selected] : [];
      }
      return pids.map(function (pid) { return snapshot(pid) || { pid: Number(pid), generation: null }; });
    },
    observe: function (pid) {
      // NSRunningApplication/NSWorkspace observations refresh on the run loop.
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.001));
      var value = snapshot(pid);
      if (value) value.frontmostPid = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
      return value;
    },
    activate: function (target) {
      var current = snapshot(target.pid);
      if (!current || current.generation !== target.generation) return false;
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(target.pid);
      return !app.isNil() && !app.terminated && Boolean(app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps));
    },
    now: function () { return Number($.NSProcessInfo.processInfo.systemUptime) * 1000; },
    wait: function (milliseconds) {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(milliseconds / 1000));
    },
    send: function (request, target, checkFocus) {
      if (!$.CGPreflightPostEventAccess()) throw new Error("Accessibility permission is required to send input.");
      if (request.sub === "type") {
        // System Events keystroke can remap non-Latin text through the current
        // keyboard layout. Preserve each Unicode scalar and address its events
        // to the pinned PID. Do not use or replace the user's clipboard.
        for (var index = 0; index < request.text.length; index++) {
          var character = request.text[index];
          var code = request.text.charCodeAt(index);
          if (code >= 0xD800 && code <= 0xDBFF && index + 1 < request.text.length) {
            var next = request.text.charCodeAt(index + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) character += request.text[++index];
          }
          postKey(target, 0, 0, character, checkFocus);
        }
      }
      else {
        var action = request.keyAction;
        var key = action.code !== undefined ? { code: action.code, flags: 0 } : keyForCharacter(action.character);
        var modifierFlags = { "command down": 1048576, "control down": 262144, "option down": 524288, "shift down": 131072 };
        action.modifiers.forEach(function (modifier) { key.flags |= modifierFlags[modifier]; });
        postKey(target, key.code, key.flags, undefined, checkFocus);
      }
    },
  };
}

export function computerInputScript(request) {
  return `var request = ${JSON.stringify(request)};\n` +
    `${performComputerInput.toString()}\n${createMacComputerDesktop.toString()}\n` +
    `JSON.stringify(performComputerInput(request, createMacComputerDesktop()));`;
}

export function runMacComputerInput(request, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("computer_unsupported_platform: Desktop input requires macOS.");
  const result = run("osascript", ["-l", "JavaScript", "-e", computerInputScript(request)], {
    encoding: "utf8", timeout: 15_000,
  });
  if (result.status !== 0) {
    const cause = result.error?.code || result.stderr?.trim() || "osascript failed";
    throw new Error(`computer_native_error: ${cause}. Input status is unknown; inspect the app before retrying.`);
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch {
    throw new Error("computer_invalid_receipt: Input status is unknown; inspect the app before retrying.");
  }
  if (receipt?.ok !== true) {
    throw new Error(`${receipt?.error?.code ?? "computer_native_error"}: ${receipt?.error?.message ?? "Desktop input failed."}`);
  }
  if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 1 || receipt.action !== request.sub ||
      (request.pid !== undefined && request.pid !== receipt.pid)) {
    throw new Error("computer_invalid_receipt: Input status is unknown; inspect the app before retrying.");
  }
  return receipt;
}
