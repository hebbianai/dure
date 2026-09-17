import AppKit
import ApplicationServices
import Foundation

private let arguments = CommandLine.arguments
guard arguments.count == 5,
      let deltaX = Double(arguments[3]),
      let deltaY = Double(arguments[4]) else {
  fputs(
    "usage: floating-pane-drag <window-title> <pane-title> <delta-x> <delta-y>\n",
    stderr
  )
  exit(2)
}

private let windowTitle = arguments[1]
private let paneTitle = arguments[2]

private func fail(_ message: String) -> Never {
  fputs("floating-pane-drag: \(message)\n", stderr)
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

private func paneTitleElement(in window: AXUIElement) -> AXUIElement? {
  let candidates = descendants(window).compactMap { element -> (AXUIElement, CGFloat)? in
    let strings = [
      text(element, kAXTitleAttribute as CFString),
      text(element, kAXDescriptionAttribute as CFString),
      text(element, kAXValueAttribute as CFString),
    ]
    guard strings.contains(where: { $0 == paneTitle || $0.contains(paneTitle) }),
          let dimensions = size(element, kAXSizeAttribute as CFString),
          dimensions.width >= 8,
          dimensions.height >= 8,
          dimensions.height <= 80 else { return nil }
    return (element, dimensions.width * dimensions.height)
  }
  return candidates.min(by: { $0.1 < $1.1 })?.0
}

private func post(_ type: CGEventType, at position: CGPoint, source: CGEventSource) {
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
  title: AXUIElement
)?
repeat {
  if let (app, application, window) = matchingWindow(),
     let title = paneTitleElement(in: window) {
    fixture = (app, application, window, title)
    break
  }
  usleep(100_000)
} while Date() < lookupDeadline

guard let fixture else {
  fail("the isolated WKWebView fixture did not expose the floating pane title")
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
  usleep(50_000)
} while Date() < activationDeadline
guard fixture.app.isActive else {
  fail("could not activate the isolated QA app for native mouse input")
}

guard let refreshedTitle = paneTitleElement(in: fixture.window),
      let start = center(refreshedTitle) else {
  fail("the floating pane title geometry became unavailable before drag")
}
let destination = CGPoint(x: start.x + deltaX, y: start.y + deltaY)
post(.mouseMoved, at: start, source: eventSource)
usleep(150_000)
post(.leftMouseDown, at: start, source: eventSource)
usleep(150_000)
for step in 1...24 {
  let progress = Double(step) / 24.0
  post(
    .leftMouseDragged,
    at: CGPoint(
      x: start.x + deltaX * progress,
      y: start.y + deltaY * progress
    ),
    source: eventSource
  )
  usleep(20_000)
}
post(.leftMouseUp, at: destination, source: eventSource)

let moveDeadline = Date().addingTimeInterval(8)
var final = start
repeat {
  if let title = paneTitleElement(in: fixture.window), let current = center(title) {
    final = current
    if current.x - start.x >= 80, current.y - start.y >= 45 { break }
  }
  usleep(100_000)
} while Date() < moveDeadline

guard final.x - start.x >= 80, final.y - start.y >= 45 else {
  fail(
    "the pane did not move on the first visible-header drag " +
      "(before=\(Int(start.x)),\(Int(start.y)); after=\(Int(final.x)),\(Int(final.y)))"
  )
}

let report: [String: Any] = [
  "schemaVersion": 1,
  "beforeX": Int(start.x),
  "beforeY": Int(start.y),
  "afterX": Int(final.x),
  "afterY": Int(final.y),
]
guard let encoded = try? JSONSerialization.data(
  withJSONObject: report,
  options: [.sortedKeys]
) else {
  fail("could not encode the drag receipt")
}
print(String(decoding: encoded, as: UTF8.self))
