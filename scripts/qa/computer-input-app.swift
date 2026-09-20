import AppKit
import Foundation

// Disposable receiver for computer-input-smoke.mjs. It never posts key events.
final class RecordingTextView: NSTextView {
  var keys: [[String: Any]] = []
  override func keyDown(with event: NSEvent) {
    keys.append(["characters": event.characters ?? "", "keyCode": Int(event.keyCode),
                 "flags": event.modifierFlags.rawValue])
    super.keyDown(with: event)
  }
}

final class Receiver: NSObject, NSApplicationDelegate, NSTextViewDelegate {
  let root: URL
  let slot: String
  let text = RecordingTextView(frame: NSRect(x: 12, y: 12, width: 510, height: 230))
  var window: NSWindow!
  var timer: Timer?
  var reset: Int = -1
  var activations = 0
  var redirected = false
  var control: [String: Any] = [:]

  init(root: URL, slot: String) { self.root = root; self.slot = slot }

  func writeState() {
    let value: [String: Any] = [
      "pid": Int(ProcessInfo.processInfo.processIdentifier), "slot": slot,
      "text": text.string, "selectionLength": text.selectedRange().length,
      "active": NSApp.isActive, "activations": activations, "reset": reset,
      "keys": text.keys,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
      try? data.write(to: root.appendingPathComponent("receiver-\(slot).json"), options: .atomic)
    }
  }

  func readControl() {
    if let data = try? Data(contentsOf: root.appendingPathComponent("control-\(slot).json")),
       let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      control = value
      if let sequence = value["reset"] as? Int, sequence != reset {
        reset = sequence
        redirected = false
        text.string = ""
        text.keys = []
        text.setSelectedRange(NSRange(location: 0, length: 0))
      }
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect: NSRect(x: 120 + (slot == "B" ? 560 : 0), y: 160, width: 540, height: 280),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Dure Computer Input QA \(slot)"
    text.isRichText = false
    text.font = NSFont.monospacedSystemFont(ofSize: 18, weight: .regular)
    text.delegate = self
    window.contentView?.addSubview(text)
    window.makeFirstResponder(text)
    window.orderFront(nil)
    let menu = NSMenu()
    let edit = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = editMenu
    menu.addItem(edit)
    NSApp.mainMenu = menu
    readControl()
    writeState()
    timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
      self?.readControl()
      self?.writeState()
    }
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    activations += 1
    window?.makeKey()
    window?.makeFirstResponder(text)
    readControl()
    if control["exitOnActivation"] as? Bool == true { NSApp.terminate(nil); return }
    if control["redirectAfterCharacters"] == nil { redirectFocus() }
    writeState()
  }

  func redirectFocus() {
    if !redirected, let pid = control["redirectPid"] as? Int32,
       let other = NSRunningApplication(processIdentifier: pid),
       let url = other.bundleURL,
       url.deletingLastPathComponent().resolvingSymlinksInPath() == root.resolvingSymlinksInPath() {
      // Only another receiver in this exact owned QA root can take focus.
      redirected = true
      other.activate(options: [.activateIgnoringOtherApps])
    }
  }

  func textDidChange(_ notification: Notification) {
    if let threshold = control["redirectAfterCharacters"] as? Int,
       text.string.count >= threshold { redirectFocus() }
  }
}

guard CommandLine.arguments.count == 3 else { exit(2) }
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL
guard root.lastPathComponent.hasPrefix("dure-computer-smoke-"),
      ["A", "B", "duplicate", "exit"].contains(CommandLine.arguments[2]),
      ProcessInfo.processInfo.environment["DURE_COMPUTER_QA_FOREGROUND"] == "1" else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let receiver = Receiver(root: root, slot: CommandLine.arguments[2])
app.delegate = receiver
app.run()
