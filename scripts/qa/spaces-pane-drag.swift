import AppKit
import ApplicationServices
import Foundation

private let arguments = CommandLine.arguments
guard arguments.count == 5 else {
  fputs(
    "usage: spaces-pane-drag <window-title> <source-prefix> <target-title> <movement>\n",
    stderr
  )
  exit(2)
}

private let windowTitle = arguments[1]
private let sourcePrefix = arguments[2]
private let targetTitle = arguments[3]
private let movement = arguments[4]
guard movement == "down" || movement == "up" else {
  fputs("spaces-pane-drag: movement must be down or up\n", stderr)
  exit(2)
}

private func fail(_ message: String) -> Never {
  fputs("spaces-pane-drag: \(message)\n", stderr)
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

private func point(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
  guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else {
    return nil
  }
  let value = unsafeBitCast(raw, to: AXValue.self)
  guard AXValueGetType(value) == .cgPoint else { return nil }
  var result = CGPoint.zero
  return AXValueGetValue(value, .cgPoint, &result) ? result : nil
}

private func size(_ element: AXUIElement, _ name: CFString) -> CGSize? {
  guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else {
    return nil
  }
  let value = unsafeBitCast(raw, to: AXValue.self)
  guard AXValueGetType(value) == .cgSize else { return nil }
  var result = CGSize.zero
  return AXValueGetValue(value, .cgSize, &result) ? result : nil
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var result: [AXUIElement] = []
  var pending = children(root)
  while let element = pending.popLast() {
    result.append(element)
    pending.append(contentsOf: children(element))
  }
  return result
}

private func matchingWindow() -> (
  app: NSRunningApplication,
  application: AXUIElement,
  window: AXUIElement
)? {
  for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    let windows = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    if let window = windows.first(where: {
      text($0, kAXTitleAttribute as CFString) == windowTitle
    }) {
      return (app, application, window)
    }
  }
  return nil
}

private func matchingButtons(
  in window: AXUIElement
) -> (source: AXUIElement, target: AXUIElement)? {
  let buttons = descendants(window).filter {
    text($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String)
  }
  let sources = buttons.filter {
    text($0, kAXTitleAttribute as CFString).hasPrefix(sourcePrefix)
  }
  let targets = buttons.filter {
    text($0, kAXTitleAttribute as CFString) == targetTitle
  }
  guard sources.count == 1, targets.count == 1 else { return nil }
  return (sources[0], targets[0])
}

private func center(_ element: AXUIElement) -> CGPoint? {
  guard
    let origin = point(element, kAXPositionAttribute as CFString),
    let dimensions = size(element, kAXSizeAttribute as CFString)
  else { return nil }
  return CGPoint(
    x: origin.x + dimensions.width / 2,
    y: origin.y + dimensions.height / 2
  )
}

private func post(
  _ type: CGEventType,
  at position: CGPoint,
  source: CGEventSource
) {
  guard let event = CGEvent(
    mouseEventSource: source,
    mouseType: type,
    mouseCursorPosition: position,
    mouseButton: .left
  ) else {
    fail("could not construct a mouse event")
  }
  event.post(tap: .cghidEventTap)
}

guard AXIsProcessTrusted() else {
  fail("Accessibility permission is required for native mouse input")
}

let lookupDeadline = Date().addingTimeInterval(30)
var fixture: (
  app: NSRunningApplication,
  application: AXUIElement,
  window: AXUIElement,
  source: AXUIElement,
  target: AXUIElement
)?
repeat {
  if let (app, application, window) = matchingWindow(),
     let buttons = matchingButtons(in: window) {
    fixture = (app, application, window, buttons.source, buttons.target)
    break
  }
  usleep(100_000)
} while Date() < lookupDeadline

guard let fixture else {
  fail("the isolated WKWebView fixture did not expose one source row and target Space")
}

var requestedPosition = CGPoint(x: 80, y: 80)
guard let positionValue = AXValueCreate(.cgPoint, &requestedPosition) else {
  fail("could not construct the window position")
}
guard AXUIElementSetAttributeValue(
  fixture.window,
  kAXPositionAttribute as CFString,
  positionValue
) == .success else {
  fail("could not place the isolated QA window on screen")
}
usleep(200_000)

guard let eventSource = CGEventSource(stateID: .hidSystemState) else {
  fail("could not create the native input source")
}
let activationDeadline = Date().addingTimeInterval(5)
var activationClickSent = false
repeat {
  _ = AXUIElementSetAttributeValue(
    fixture.application,
    kAXFrontmostAttribute as CFString,
    kCFBooleanTrue
  )
  _ = AXUIElementSetAttributeValue(
    fixture.window,
    kAXMainAttribute as CFString,
    kCFBooleanTrue
  )
  fixture.app.activate(options: [.activateAllWindows])
  _ = AXUIElementPerformAction(fixture.window, kAXRaiseAction as CFString)
  if fixture.app.isActive { break }
  if !activationClickSent, let activationPoint = center(fixture.source) {
    post(.mouseMoved, at: activationPoint, source: eventSource)
    post(.leftMouseDown, at: activationPoint, source: eventSource)
    post(.leftMouseUp, at: activationPoint, source: eventSource)
    activationClickSent = true
  }
  usleep(50_000)
} while Date() < activationDeadline
guard fixture.app.isActive else {
  fail("could not activate the isolated QA app for native mouse input")
}

guard
  let refreshedButtons = matchingButtons(in: fixture.window),
  let start = center(refreshedButtons.source),
  let destination = center(refreshedButtons.target)
else {
  fail("the pane row geometry became unavailable before drag")
}
let startsOnExpectedSide = movement == "down" ? start.y < destination.y : start.y > destination.y
guard startsOnExpectedSide else {
  fail("the source pane was not rendered on the expected side before drag")
}

post(.mouseMoved, at: start, source: eventSource)
usleep(150_000)
post(.leftMouseDown, at: start, source: eventSource)
usleep(350_000)
for step in 1...30 {
  let progress = Double(step) / 30.0
  post(
    .leftMouseDragged,
    at: CGPoint(
      x: start.x + (destination.x - start.x) * progress,
      y: start.y + (destination.y - start.y) * progress
    ),
    source: eventSource
  )
  usleep(25_000)
}
usleep(300_000)
post(.leftMouseUp, at: destination, source: eventSource)

let moveDeadline = Date().addingTimeInterval(10)
var finalSource: CGPoint?
var finalTarget: CGPoint?
repeat {
  if let buttons = matchingButtons(in: fixture.window),
     let source = center(buttons.source),
     let target = center(buttons.target) {
    finalSource = source
    finalTarget = target
    let movedInDirection = movement == "down" ? source.y > start.y : source.y < start.y
    if source.y > target.y, movedInDirection { break }
  }
  usleep(100_000)
} while Date() < moveDeadline

guard
  let finalSource,
  let finalTarget,
  finalSource.y > finalTarget.y,
  movement == "down" ? finalSource.y > start.y : finalSource.y < start.y
else {
  let sourceBeforeY = Int(start.y)
  let targetBeforeY = Int(destination.y)
  let sourceAfterY = Int(finalSource?.y ?? -1)
  let targetAfterY = Int(finalTarget?.y ?? -1)
  let detail =
    "active=\(fixture.app.isActive), movement=\(movement), sourceBefore=\(sourceBeforeY), " +
    "targetBefore=\(targetBeforeY), sourceAfter=\(sourceAfterY), targetAfter=\(targetAfterY)"
  fail("the pane row did not move into the target Space (\(detail))")
}

let report: [String: Any] = [
  "schemaVersion": 1,
  "movement": movement,
  "sourceBeforeY": Int(start.y),
  "targetBeforeY": Int(destination.y),
  "sourceAfterY": Int(finalSource.y),
  "targetAfterY": Int(finalTarget.y),
]
guard let encoded = try? JSONSerialization.data(
  withJSONObject: report,
  options: [.sortedKeys]
) else {
  fail("could not encode the drag receipt")
}
print(String(decoding: encoded, as: UTF8.self))
