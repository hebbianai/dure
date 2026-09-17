import AppKit
import ApplicationServices
import Foundation

private let arguments = CommandLine.arguments
guard arguments.count == 5,
      let relativeX = Double(arguments[2]),
      let relativeY = Double(arguments[3]),
      let deltaX = Double(arguments[4]) else {
  fputs(
    "usage: terminal-sash-resize <window-title> <relative-x> <relative-y> <delta-x>\n",
    stderr
  )
  exit(2)
}

private let windowTitle = arguments[1]

private func fail(_ message: String) -> Never {
  fputs("terminal-sash-resize: \(message)\n", stderr)
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

private func drag(
  from start: CGPoint,
  to destination: CGPoint,
  source: CGEventSource,
  releaseAt: CGPoint? = nil
) {
  post(.mouseMoved, at: start, source: source)
  usleep(120_000)
  post(.leftMouseDown, at: start, source: source)
  usleep(120_000)
  for step in 1...24 {
    let progress = Double(step) / 24.0
    post(
      .leftMouseDragged,
      at: CGPoint(
        x: start.x + (destination.x - start.x) * progress,
        y: start.y + (destination.y - start.y) * progress
      ),
      source: source
    )
    usleep(16_000)
  }
  if let releaseAt {
    post(.leftMouseDragged, at: releaseAt, source: source)
    usleep(120_000)
    post(.leftMouseUp, at: releaseAt, source: source)
  } else {
    post(.leftMouseUp, at: destination, source: source)
  }
}

guard AXIsProcessTrusted() else {
  fail("Accessibility permission is required for native mouse input")
}

let lookupDeadline = Date().addingTimeInterval(30)
var fixture: (
  app: NSRunningApplication,
  application: AXUIElement,
  window: AXUIElement
)?
repeat {
  if let candidate = matchingWindow() {
    fixture = candidate
    break
  }
  usleep(100_000)
} while Date() < lookupDeadline

guard let fixture else {
  fail("the isolated WKWebView fixture window was not found")
}

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

guard
  let windowOrigin = point(fixture.window, kAXPositionAttribute as CFString),
  let windowSize = size(fixture.window, kAXSizeAttribute as CFString),
  relativeX > 0,
  relativeY > 0,
  relativeX < windowSize.width,
  relativeY < windowSize.height
else {
  fail("the reported WebView sash point is outside the native window")
}

let firstBoundary = CGPoint(
  x: windowOrigin.x + relativeX,
  y: windowOrigin.y + relativeY
)
let normalDestination = CGPoint(x: firstBoundary.x + deltaX, y: firstBoundary.y)
drag(from: firstBoundary, to: normalDestination, source: eventSource)
usleep(700_000)

let recoveryDestination = CGPoint(
  x: normalDestination.x - deltaX / 2,
  y: normalDestination.y
)
let outsideRelease = CGPoint(x: recoveryDestination.x, y: windowOrigin.y - 24)
drag(
  from: normalDestination,
  to: recoveryDestination,
  source: eventSource,
  releaseAt: outsideRelease
)
usleep(120_000)
post(.mouseMoved, at: recoveryDestination, source: eventSource)
usleep(700_000)

let report: [String: Any] = [
  "schemaVersion": 1,
  "firstBoundaryX": Int(firstBoundary.x),
  "normalDestinationX": Int(normalDestination.x),
  "outsideReleaseY": Int(outsideRelease.y),
]
guard let encoded = try? JSONSerialization.data(
  withJSONObject: report,
  options: [.sortedKeys]
) else {
  fail("could not encode the native sash receipt")
}
print(String(decoding: encoded, as: UTF8.self))
