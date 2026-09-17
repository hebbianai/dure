import AppKit
import ApplicationServices
import Carbon
import Darwin
import Foundation

private let koreanSourceID = "com.apple.inputmethod.Korean.2SetKorean"

private func fail(_ message: String) -> Never {
  fputs("browser-os-ime-keydown: \(message)\n", stderr)
  exit(1)
}

private func sourceID(_ source: TISInputSource) -> String? {
  guard let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
    return nil
  }
  return Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue() as String
}

private func currentSourceID() -> String? {
  guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
    return nil
  }
  return sourceID(source)
}

private func emit(_ receipt: [String: Any]) {
  guard let encoded = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]) else {
    fail("could not encode the native input receipt")
  }
  print(String(decoding: encoded, as: UTF8.self))
}

// Inspection never activates an app, requests permission, or changes an input source.
if CommandLine.arguments == [CommandLine.arguments[0], "--inspect"] {
  let sources = TISCreateInputSourceList(nil, false)?.takeRetainedValue() as? [TISInputSource] ?? []
  emit([
    "schemaVersion": 1,
    "currentSourceId": currentSourceID() ?? "",
    "requiredSourceId": koreanSourceID,
    "koreanEnabled": sources.contains { sourceID($0) == koreanSourceID },
    "accessibilityTrusted": AXIsProcessTrusted(),
  ])
  exit(0)
}

private let arguments = CommandLine.arguments
guard arguments.count == 7,
      let appPID = pid_t(arguments[1]), appPID > 1,
      let expectedGroup = pid_t(arguments[2]), expectedGroup > 1,
      let expectedUniqueID = UInt64(arguments[3]), expectedUniqueID > 0,
      let minimumIdleMs = Int(arguments[6]), minimumIdleMs >= 0, minimumIdleMs <= 3_600_000 else {
  fail("usage: browser-os-ime-keydown <app-pid> <process-group> <process-unique-id> <window-title> <input-label> <minimum-idle-ms>")
}
guard ProcessInfo.processInfo.environment["HEBBIAN_QA_ALLOW_FOCUS_STEAL"] == "1",
      ProcessInfo.processInfo.environment["DURE_QA_LAYER"] == "exclusive_focus_browser_ime" else {
  fail("exclusive Browser IME maintenance-window admission is required")
}
private let targetTitle = arguments[4]
private let inputLabel = arguments[5]
guard targetTitle == "Dure Browser Panel QA", !inputLabel.isEmpty else {
  fail("the exact Browser QA window and input label are required")
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

private func element(_ parent: AXUIElement, _ name: CFString) -> AXUIElement? {
  guard let raw = attribute(parent, name), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(raw, to: AXUIElement.self)
}

private func processUniqueID(_ pid: pid_t) -> UInt64? {
  var bytes = [UInt8](repeating: 0, count: 56)
  let count = bytes.withUnsafeMutableBytes { storage in
    proc_pidinfo(pid, 17, 0, storage.baseAddress, Int32(storage.count))
  }
  guard count == bytes.count else { return nil }
  return bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 16, as: UInt64.self) }
}

private let application = AXUIElementCreateApplication(appPID)
private func validateTarget() {
  guard getpgid(appPID) == expectedGroup, processUniqueID(appPID) == expectedUniqueID else {
    fail("the runner-owned app process generation changed")
  }
  guard AXIsProcessTrusted(), let app = NSRunningApplication(processIdentifier: appPID),
        !app.isTerminated, app.isActive else {
    fail("Accessibility permission and the exact active QA app are required")
  }
  let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  let targets = windows.filter { attribute($0, kAXTitleAttribute as CFString) as? String == targetTitle }
  guard targets.count == 1,
        attribute(targets[0], kAXMainAttribute as CFString) as? Bool == true,
        attribute(targets[0], kAXMinimizedAttribute as CFString) as? Bool == false,
        let focusedWindow = element(application, kAXFocusedWindowAttribute as CFString),
        CFEqual(focusedWindow, targets[0]) else {
    fail("the unique Browser QA window is not focused")
  }
  guard let receiver = element(application, kAXFocusedUIElementAttribute as CFString),
        attribute(receiver, kAXRoleAttribute as CFString) as? String == (kAXTextAreaRole as String),
        [kAXTitleAttribute, kAXDescriptionAttribute].contains(where: {
          attribute(receiver, $0 as CFString) as? String == inputLabel
        }) else {
    fail("the exact Browser page textarea is not the native focused receiver")
  }
  guard currentSourceID() == koreanSourceID else {
    fail("select the macOS two-set Korean input source before this maintenance-window test")
  }
}

validateTarget()
guard let anyInput = CGEventType(rawValue: UInt32.max) else { fail("HID idle probe is unavailable") }
private let idleSeconds = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
guard idleSeconds.isFinite, idleSeconds >= Double(minimumIdleMs) / 1_000,
      idleSeconds < Double(Int.max) / 1_000 else {
  fail("fresh HID activity appeared after exclusive-input admission")
}
private let idleMs = Int(idleSeconds * 1_000)
guard let source = CGEventSource(stateID: .hidSystemState) else { fail("could not create a native event source") }
// Physical key positions g,k,s,r,m,f compose 한글 in the two-set input method.
// Space commits the final syllable. No Unicode payload or paste bypasses the OS IME.
private let keyCodes = [kVK_ANSI_G, kVK_ANSI_K, kVK_ANSI_S, kVK_ANSI_R, kVK_ANSI_M, kVK_ANSI_F, kVK_Space]
for code in keyCodes {
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false) else {
    fail("could not create the native key pair")
  }
  down.flags = []
  up.flags = []
  validateTarget()
  down.postToPid(appPID)
  up.postToPid(appPID)
  // Match an ordinary typing cadence; completion is observed by the WebView client.
  Thread.sleep(forTimeInterval: 0.08)
}
validateTarget()
emit([
  "schemaVersion": 1,
  "processId": Int(appPID), "processGroupId": Int(expectedGroup),
  "processUniqueId": String(expectedUniqueID),
  "inputSourceId": koreanSourceID,
  "postedEventCount": keyCodes.count * 2,
  "keyCodes": keyCodes,
  "idleMillisecondsAtPost": idleMs,
])
