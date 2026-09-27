// macOS adapter executed by osascript. Public ApplicationServices APIs only.
// Foreground taps require explicit per-action opt-in. Never changes settings or clipboard.
function mirroringDesktop() {
	ObjC.import("AppKit");
	ObjC.import("ApplicationServices");
	ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
	ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]);
	ObjC.bindFunction("CGEventPostToPid", ["void", ["int", "void *"]]);
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
	function process(pid) {
		var app =
			$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
		if (app.isNil() || app.terminated)
			throw new Error("The selected application exited.");
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
		return { pid: Number(pid), generation: generation };
	}
	function frontmost() {
		$.NSRunLoop.currentRunLoop.runUntilDate(
			$.NSDate.dateWithTimeIntervalSinceNow(0.001),
		);
		return process(
			Number(
				$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,
			),
		);
	}
	function activate(target) {
		if (process(target.pid).generation !== target.generation) return false;
		return Boolean(
			$.NSRunningApplication.runningApplicationWithProcessIdentifier(
				target.pid,
			).activateWithOptions($.NSApplicationActivateIgnoringOtherApps),
		);
	}
	var lastPointer = null;
	var focusDesktop = {
		process: process,
		frontmost: frontmost,
		activate: activate,
		now: function () {
			return Number($.NSProcessInfo.processInfo.systemUptime) * 1000;
		},
		wait: function (ms) {
			$.NSRunLoop.currentRunLoop.runUntilDate(
				$.NSDate.dateWithTimeIntervalSinceNow(ms / 1000),
			);
		},
		pointer: function () {
			return $.CGEventGetLocation($.CGEventCreate(null));
		},
		restorePointer: function (point) {
			var current = this.pointer();
			// Do not overwrite a pointer movement made by the person.
			if (
				lastPointer &&
				Math.abs(current.x - lastPointer.x) < 2 &&
				Math.abs(current.y - lastPointer.y) < 2
			)
				$.CGWarpMouseCursorPosition(point);
		},
	};

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
		var generation = process(pid).generation;
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
		foreground: function (target, operation) {
			if (!$.CGPreflightPostEventAccess())
				throw new Error(
					"Accessibility permission is required for foreground taps.",
				);
			return withMirroringForeground(target, focusDesktop, operation);
		},
		send: function (target, action, check) {
			if (action.kind === "gesture") {
				var b = target.bounds;
				var point = $.CGPointMake(
					b.X + action.start.x * (b.Width - 1),
					b.Y + action.start.y * (b.Height - 1),
				);
				function event(type) {
					var e = $.CGEventCreateMouseEvent(
						$.CGEventSourceCreate(-1),
						type,
						point,
						0,
					);
					$.CGEventSetFlags(e, 0);
					$.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, 1);
					$.CGEventSetIntegerValueField(
						e,
						$.kCGMouseEventWindowUnderMousePointer,
						target.windowId,
					);
					$.CGEventSetIntegerValueField(
						e,
						$.kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,
						target.windowId,
					);
					return e;
				}
				function post(type) {
					check();
					$.CGEventPost($.kCGHIDEventTap, event(type));
					lastPointer = point;
				}
				post(5);
				focusDesktop.wait(50);
				post(1);
				var released = false;
				try {
					focusDesktop.wait(50);
					post(2);
					released = true;
				} finally {
					// A focus change must never send a release/click to another app.
					if (
						!released &&
						process(target.pid).generation === target.id.split(":")[2]
					)
						$.CGEventPostToPid(target.pid, event(2));
				}
				return;
			}
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
	var tap = action.kind === "gesture";
	if (tap) {
		if (action.foreground !== true)
			throw new Error(
				"Physical iPhone taps require explicit foreground=true; iPhone Mirroring briefly comes forward.",
			);
		[action.start, action.end].forEach(function (p) {
			if (
				!p ||
				!Number.isFinite(p.x) ||
				!Number.isFinite(p.y) ||
				p.x < 0 ||
				p.x > 1 ||
				p.y < 0 ||
				p.y > 1
			)
				throw new Error("Tap coordinates must be between 0 and 1.");
		});
		if (
			Math.abs(action.start.x - action.end.x) +
				Math.abs(action.start.y - action.end.y) >=
			0.01
		)
			throw new Error(
				"Physical iPhone swipes are unavailable; use a tap or Apple window.",
			);
		if (
			!request.frameBounds ||
			["X", "Y", "Width", "Height"].some(function (k) {
				return request.frameBounds[k] !== target.bounds[k];
			})
		)
			throw new Error(
				"iPhone view changed; capture a fresh screenshot before tapping.",
			);
	} else if (
		action.kind !== "button" ||
		["home", "recents"].indexOf(action.button) < 0
	) {
		throw new Error(
			"iPhone Mirroring supports preview, Home and App Switcher, plus explicitly enabled foreground taps. Typing, keys, installation and launch are unavailable.",
		);
	}

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
	function dispatch(focusCheck) {
		function checked() {
			check();
			if (focusCheck) focusCheck();
		}
		checked();
		desktop.send(target, action, checked);
		checked();
	}
	if (tap) desktop.foreground(target, dispatch);
	else dispatch();
	return target;
}

// A bounded focus transaction. Observations are refreshed before each event;
// restoration is conditional so a person's app switch always wins.
function withMirroringForeground(target, desktop, operation) {
	var selected = desktop.process(target.pid);
	if (selected.generation !== target.id.split(":")[2])
		throw new Error("Mirroring process changed.");
	var previous = desktop.frontmost(),
		pointer = desktop.pointer();
	function same(a, b) {
		return a && b && a.pid === b.pid && a.generation === b.generation;
	}
	function check() {
		if (
			!same(desktop.process(selected.pid), selected) ||
			!same(desktop.frontmost(), selected)
		)
			throw new Error(
				"Mirroring lost foreground; input stopped. Inspect before retrying.",
			);
	}
	try {
		if (!same(desktop.frontmost(), previous))
			throw new Error("Desktop focus changed before activation.");
		if (!desktop.activate(selected))
			throw new Error("macOS refused to activate iPhone Mirroring.");
		var deadline = desktop.now() + 3000;
		while (!same(desktop.frontmost(), selected)) {
			if (!same(desktop.process(selected.pid), selected))
				throw new Error("Mirroring process changed.");
			if (!same(desktop.frontmost(), previous))
				throw new Error("Desktop focus changed during activation.");
			if (desktop.now() >= deadline)
				throw new Error("iPhone Mirroring activation timed out.");
			desktop.wait(25);
		}
		check();
		operation(check);
		check();
	} finally {
		// Never reactivate a replacement process or override another foreground app.
		var current;
		try {
			current = desktop.frontmost();
		} catch (_) {
			current = null;
		}
		if (same(current, selected)) {
			var old;
			try {
				old = desktop.process(previous.pid);
			} catch (_) {
				old = null;
			}
			if (same(old, previous)) {
				desktop.restorePointer(pointer);
				if (!same(previous, selected) && !desktop.activate(previous))
					throw new Error(
						"Input may have been sent; previous application focus could not be restored.",
					);
			}
		}
	}
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
