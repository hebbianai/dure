import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2,
      let requestedPID = Int(CommandLine.arguments[1]),
      requestedPID > 1 else {
  FileHandle.standardError.write(Data("usage: macos-window-probe.swift PID\n".utf8))
  exit(2)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
  as? [[String: Any]] else {
  FileHandle.standardError.write(Data("cannot enumerate CoreGraphics windows\n".utf8))
  exit(3)
}

var windows: [[String: Any]] = []
for raw in rawWindows {
  let ownerPID = (raw[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? -1
  if ownerPID != requestedPID { continue }
  guard let number = (raw[kCGWindowNumber as String] as? NSNumber)?.intValue,
        let rawBounds = raw[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: rawBounds) else {
    continue
  }
  windows.append([
    "windowId": number,
    "title": raw[kCGWindowName as String] as? String ?? "",
    "ownerName": raw[kCGWindowOwnerName as String] as? String ?? "",
    "ownerPid": ownerPID,
    "layer": (raw[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1,
    "alpha": (raw[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0,
    "onScreen": raw[kCGWindowIsOnscreen as String] as? Bool ?? false,
    "sharingState": (raw[kCGWindowSharingState as String] as? NSNumber)?.intValue ?? -1,
    "bounds": [
      "x": bounds.origin.x,
      "y": bounds.origin.y,
      "width": bounds.size.width,
      "height": bounds.size.height,
    ],
  ])
}
windows.sort {
  ($0["windowId"] as? Int ?? 0) < ($1["windowId"] as? Int ?? 0)
}
let output: [String: Any] = [
  "schemaVersion": 1,
  "ownerPid": requestedPID,
  "windows": windows,
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
