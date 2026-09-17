import AppKit
import ApplicationServices
import Darwin
import Foundation

private let arguments = CommandLine.arguments
guard (arguments.count == 7 || arguments.count == 9),
      let appPID = pid_t(arguments[1]),
      let expectedProcessGroup = pid_t(arguments[2]),
      let expectedProcessUniqueID = UInt64(arguments[3]),
      let minimumIdleMilliseconds = Int(arguments[6]),
      appPID > 1,
      expectedProcessGroup > 1,
      expectedProcessUniqueID > 0,
      minimumIdleMilliseconds >= 0,
      minimumIdleMilliseconds <= 3_600_000 else {
  fputs(
    "usage: hmux-input-latency-keydown <app-pid> <process-group> <process-unique-id> <target-title> <sibling-title> <minimum-idle-ms> [<click-screen-x> <click-screen-y>]\n",
    stderr
  )
  exit(2)
}

private let targetTitle = arguments[4]
private let siblingTitle = arguments[5]
private let hasClick = arguments.count == 9
private let processUniqueIdentifierInfo = Int32(17)
private let processUniqueIdentifierInfoSize = 56

private func fail(_ message: String) -> Never {
  fputs("hmux-input-latency-keydown: \(message)\n", stderr)
  exit(1)
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
    return nil
  }
  return value
}

private func text(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

private func boolean(_ element: AXUIElement, _ name: CFString) -> Bool? {
  attribute(element, name) as? Bool
}

private func element(_ parent: AXUIElement, _ name: CFString) -> AXUIElement? {
  guard let raw = attribute(parent, name),
        CFGetTypeID(raw) == AXUIElementGetTypeID() else {
    return nil
  }
  return unsafeBitCast(raw, to: AXUIElement.self)
}

private func processUniqueID(_ pid: pid_t) -> UInt64? {
  var bytes = [UInt8](repeating: 0, count: processUniqueIdentifierInfoSize)
  let size = bytes.withUnsafeMutableBytes { storage in
    proc_pidinfo(
      pid,
      processUniqueIdentifierInfo,
      0,
      storage.baseAddress,
      Int32(storage.count)
    )
  }
  guard size == processUniqueIdentifierInfoSize else { return nil }
  return bytes.withUnsafeBytes { storage in
    storage.loadUnaligned(fromByteOffset: 16, as: UInt64.self)
  }
}

guard getpgid(appPID) == expectedProcessGroup else {
  fail("the isolated app PID is not in the runner-owned process group")
}
guard processUniqueID(appPID) == expectedProcessUniqueID else {
  fail("the isolated app process generation changed before input")
}
guard AXIsProcessTrusted() else {
  fail("Accessibility permission is required for isolated native input")
}
guard let app = NSRunningApplication(processIdentifier: appPID),
      !app.isTerminated,
      app.isActive else {
  fail("the exact isolated app process is not active")
}

private let application = AXUIElementCreateApplication(appPID)
private let windows =
  attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
private let targets = windows.filter {
  text($0, kAXTitleAttribute as CFString) == targetTitle
}
private let siblings = windows.filter {
  text($0, kAXTitleAttribute as CFString) == siblingTitle
}
guard targets.count == 1,
      (siblings.count == 1 || (hasClick && siblingTitle.isEmpty)) else {
  fail("the exact target and sibling QA windows were not both unique")
}

private let target = targets[0]
private let sibling = siblings.first
guard boolean(target, kAXMainAttribute as CFString) == true,
      boolean(target, kAXMinimizedAttribute as CFString) == false,
      sibling.map({ boolean($0, kAXMainAttribute as CFString) == false }) ?? true else {
  fail("the isolated QA window main/minimized state changed before input")
}
guard let focusedWindow = element(
        application,
        kAXFocusedWindowAttribute as CFString
      ),
      CFEqual(focusedWindow, target) else {
  fail("the exact target QA window is not focused")
}

guard let source = CGEventSource(stateID: .hidSystemState),
      let keyDown = CGEvent(
        keyboardEventSource: source,
        virtualKey: 7,
        keyDown: true
      ),
      let keyUp = CGEvent(
        keyboardEventSource: source,
        virtualKey: 7,
        keyDown: false
      ) else {
  fail("could not construct the isolated native key events")
}
var character: UniChar = 0x0078
keyDown.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
keyUp.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
keyDown.flags = []
keyUp.flags = []

private var clickEvents: [CGEvent] = []
if hasClick {
  guard let x = Double(arguments[7]), let y = Double(arguments[8]),
        x.isFinite, y.isFinite,
        let rawPosition = attribute(target, kAXPositionAttribute as CFString),
        let rawSize = attribute(target, kAXSizeAttribute as CFString),
        CFGetTypeID(rawPosition) == AXValueGetTypeID(),
        CFGetTypeID(rawSize) == AXValueGetTypeID() else {
    fail("invalid isolated body click geometry")
  }
  var origin = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &origin),
        AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size),
        CGRect(origin: origin, size: size).contains(CGPoint(x: x, y: y)) else {
    fail("body click escaped the exact isolated window")
  }
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else {
      fail("could not construct isolated body click")
    }
    event.flags = []
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    clickEvents.append(event)
  }
}

private let postEventAccess = CGPreflightPostEventAccess()
guard let anyInputEvent = CGEventType(rawValue: UInt32.max) else {
  fail("the all-input HID event type is unavailable")
}
private let idleSeconds = CGEventSource.secondsSinceLastEventType(
  .hidSystemState,
  eventType: anyInputEvent
)
guard idleSeconds.isFinite,
      idleSeconds >= 0,
      idleSeconds <= Double(Int.max) / 1_000 else {
  fail("the fresh HID idle observation is invalid")
}
private let idleMilliseconds = Int(idleSeconds * 1_000)
guard idleMilliseconds >= minimumIdleMilliseconds else {
  fail("fresh HID activity appeared after exclusive-input admission")
}
guard getpgid(appPID) == expectedProcessGroup,
      processUniqueID(appPID) == expectedProcessUniqueID,
      app.isActive else {
  fail("the isolated app process generation changed before post")
}
guard boolean(target, kAXMainAttribute as CFString) == true,
      boolean(target, kAXMinimizedAttribute as CFString) == false,
      sibling.map({ boolean($0, kAXMainAttribute as CFString) == false }) ?? true,
      let finalFocusedWindow = element(
        application,
        kAXFocusedWindowAttribute as CFString
      ),
      CFEqual(finalFocusedWindow, target) else {
  fail("the exact target QA window focus changed before post")
}

// Queue the click and first key together: no refocus, AX call or delay between them.
for event in clickEvents { event.postToPid(appPID) }
keyDown.postToPid(appPID)
keyUp.postToPid(appPID)

// Do not query WebKit's focused AX element during delivery. An observation may
// synchronize the recipient; the app records focus and trusted input separately.
private let receipt: [String: Any] = [
  "schemaVersion": 1,
  "processId": Int(appPID),
  "processGroupId": Int(expectedProcessGroup),
  "postedEventCount": 2 + clickEvents.count,
  "postedClickCount": clickEvents.isEmpty ? 0 : 1,
  "idleMillisecondsAtPost": idleMilliseconds,
  "postEventAccess": postEventAccess,
]
guard let encoded = try? JSONSerialization.data(
  withJSONObject: receipt,
  options: [.sortedKeys]
) else {
  fail("could not encode the native input receipt")
}
print(String(decoding: encoded, as: UTF8.self))
