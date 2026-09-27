// macOS adapter executed by osascript. Public ApplicationServices APIs only.
// Never activates the app, changes settings, or touches the host clipboard.
function mirroringDesktop() {
	ObjC.import("AppKit");
	ObjC.import("ApplicationServices");
	ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
	ObjC.bindFunction("proc_pidinfo", [
		"int",
		["int", "int", "uint64_t", "void *", "int"],
	]);
	function attr(element, name) {
		var ref = Ref();
		return $.AXUIElementCopyAttributeValue(element, $(name), ref) === 0
			? ObjC.castRefToObject(ref[0])
			: null;
	}
	function value(element, name) {
		var result = attr(element, name);
		return result ? ObjC.unwrap(result) : null;
	}
	function children(element, name) {
		var result = attr(element, name || "AXChildren");
		var list = [];
		if (result)
			for (var i = 0; i < result.count; i++) list.push(result.objectAtIndex(i));
		return list;
	}
	function menu(app, key) {
		var found = [];
		function visit(element, depth) {
			if (depth > 4) return;
			if (
				value(element, "AXMenuItemCmdChar") === key &&
				value(element, "AXMenuItemCmdModifiers") === 0
			)
				found.push(element);
			children(element).forEach(function (child) {
				visit(child, depth + 1);
			});
		}
		var bar = attr(app, "AXMenuBar");
		if (bar) visit(bar, 0);
		return found.length === 1 ? found[0] : null;
	}
	function inspect() {
		if (!$.CGPreflightScreenCaptureAccess())
			throw new Error(
				"Screen Recording permission is required for Dure to preview iPhone Mirroring.",
			);
		if (!$.AXIsProcessTrusted())
			throw new Error(
				"Accessibility permission is required for Dure to inspect and control iPhone Mirroring.",
			);
		var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(
			"com.apple.ScreenContinuity",
		);
		if (Number(apps.count) !== 1)
			throw new Error(
				"Open iPhone Mirroring on this Mac and finish its connection and authentication first.",
			);
		var application = apps.objectAtIndex(0);
		var pid = Number(application.processIdentifier);
		var identity = $.NSMutableData.dataWithLength(56);
		if ($.proc_pidinfo(pid, 17, 0, identity.mutableBytes, 56) !== 56)
			throw new Error("Cannot verify the iPhone Mirroring process.");
		var generation = ObjC.unwrap(
			identity
				.subdataWithRange($.NSMakeRange(16, 8))
				.base64EncodedStringWithOptions(0),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
		if (generation === "AAAAAAAAAAA")
			throw new Error("Cannot verify the iPhone Mirroring process generation.");
		var app = $.AXUIElementCreateApplication(pid);
		var main = children(app, "AXWindows").filter(function (window) {
			return value(window, "AXIdentifier") === "iphone-mirroring-main";
		});
		if (main.length !== 1)
			throw new Error(
				"Finish setup in iPhone Mirroring, then refresh devices.",
			);
		var windows = ObjC.deepUnwrap(
			ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)),
		).filter(function (window) {
			return (
				window.kCGWindowOwnerPID === pid &&
				window.kCGWindowLayer === 0 &&
				window.kCGWindowBounds.Width > 100 &&
				window.kCGWindowBounds.Height > 100
			);
		});
		// There must be exactly one visible content window. Authentication and
		// settings sheets are never inferred to be the phone's screen.
		if (windows.length !== 1)
			throw new Error(
				"Keep one iPhone Mirroring window visible, close its dialogs, then refresh devices.",
			);
		var window = windows[0];
		var home = menu(app, "1");
		var ready =
			home !== null &&
			value(home, "AXEnabled") === true &&
			children(main[0], "AXSheets").length === 0;
		return {
			id: "mirroring:" + pid + ":" + generation + ":" + window.kCGWindowNumber,
			pid: pid,
			windowId: window.kCGWindowNumber,
			bounds: window.kCGWindowBounds,
			ready: ready,
		};
	}
	return {
		inspect: inspect,
		send: function (target, action, check) {
			var item = menu(
				$.AXUIElementCreateApplication(target.pid),
				action.button === "home" ? "1" : "2",
			);
			if (!item || value(item, "AXEnabled") !== true)
				throw new Error("iPhone Mirroring is not connected.");
			check();
			if ($.AXUIElementPerformAction(item, $("AXPress")) !== 0)
				throw new Error("iPhone Mirroring did not accept the menu action.");
		},
	};
}

function performMirroring(request, desktop) {
	if (request.action && !request.id)
		throw new Error("Select the exact iPhone Mirroring session before input.");
	var target = desktop.inspect();
	if (request.id && request.id !== target.id)
		throw new Error(
			"The iPhone Mirroring session changed; refresh and select it again.",
		);
	if (!request.action) return target;
	var action = request.action;
	if (
		action.kind !== "button" ||
		["home", "recents"].indexOf(action.button) < 0
	)
		throw new Error(
			"iPhone Mirroring supports preview, Home and App Switcher only. Touch, typing, keys, installation and launch are unavailable; use the Apple iPhone Mirroring window directly.",
		);
	if (!target.ready)
		throw new Error(
			"Connect the locked iPhone in iPhone Mirroring before using Home or App Switcher.",
		);
	function check() {
		var current = desktop.inspect();
		if (
			current.id !== target.id ||
			!current.ready ||
			["X", "Y", "Width", "Height"].some(function (key) {
				return current.bounds[key] !== target.bounds[key];
			})
		)
			throw new Error(
				"iPhone Mirroring changed during input; inspect the screen before retrying.",
			);
	}
	check();
	desktop.send(target, action, check);
	check();
	return target;
}

function run() {
	ObjC.import("Foundation");
	var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	var request = JSON.parse(
		ObjC.unwrap(
			$.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding),
		),
	);
	return JSON.stringify(performMirroring(request, mirroringDesktop()));
}
