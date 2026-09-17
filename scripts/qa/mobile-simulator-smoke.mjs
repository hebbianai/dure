import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

assert.equal(process.platform, "darwin", "iOS simulator smoke requires macOS");
assert.ok(existsSync(new URL("./native/serve-sim-native.node", import.meta.resolve("serve-sim/middleware"))), "Install the pinned live iOS module before QA");
const run = (program, args) => execFileSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
const root = mkdtempSync(join(tmpdir(), "dure-mobile-simulator-fixture-"));
const app = join(root, "MobileQA.app");
mkdirSync(app);
const source = join(root, "main.m");
writeFileSync(source, `#import <UIKit/UIKit.h>
#import <os/log.h>
@interface QADelegate : UIResponder <UIApplicationDelegate>
@property(strong, nonatomic) UIWindow *window;
@end
@implementation QADelegate
- (BOOL)application:(UIApplication *)app openURL:(NSURL *)url options:(NSDictionary *)options { os_log_with_type(os_log_create("com.dure.mobile-simulator-qa", "qa"), OS_LOG_TYPE_DEFAULT, "link:%{public}@", url.absoluteString); self.window.rootViewController.view.backgroundColor = [UIColor colorWithRed:180.0/255 green:100.0/255 blue:30.0/255 alpha:1]; return YES; }
- (void)tapped { os_log_with_type(os_log_create("com.dure.mobile-simulator-qa", "qa"), OS_LOG_TYPE_DEFAULT, "touch-received"); self.window.rootViewController.view.backgroundColor = [UIColor colorWithRed:40.0/255 green:150.0/255 blue:80.0/255 alpha:1]; }
- (void)typed:(UITextField *)field { os_log_with_type(os_log_create("com.dure.mobile-simulator-qa", "qa"), OS_LOG_TYPE_DEFAULT, "text:%{public}@", field.text); if ([field.text isEqualToString:@"Dure"]) self.window.rootViewController.view.backgroundColor = [UIColor colorWithRed:120.0/255 green:60.0/255 blue:190.0/255 alpha:1]; }
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
 self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
 UIViewController *controller = [UIViewController new];
 controller.view.backgroundColor = [UIColor colorWithRed:0.1 green:0.35 blue:0.65 alpha:1];
 UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(20, 200, 350, 80)];
 label.text = @"Dure simulator QA"; label.textColor = UIColor.whiteColor;
 label.font = [UIFont systemFontOfSize:28]; [controller.view addSubview:label];
 UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem]; button.frame = CGRectMake(20, 330, 350, 80); [button setTitle:@"Tap QA" forState:UIControlStateNormal]; button.backgroundColor = UIColor.whiteColor; [button addTarget:self action:@selector(tapped) forControlEvents:UIControlEventTouchUpInside]; [controller.view addSubview:button];
 UITextField *field = [[UITextField alloc] initWithFrame:CGRectMake(20, 440, 350, 60)]; field.backgroundColor = UIColor.whiteColor; [field addTarget:self action:@selector(typed:) forControlEvents:UIControlEventEditingChanged]; [controller.view addSubview:field];
 self.window.rootViewController = controller; [self.window makeKeyAndVisible]; return YES;
}
@end
int main(int argc, char *argv[]) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, @"QADelegate"); } }
`);
writeFileSync(join(app, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.dure.mobile-simulator-qa</string><key>CFBundleExecutable</key><string>MobileQA</string><key>CFBundleName</key><string>Mobile QA</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string><key>LSRequiresIPhoneOS</key><true/><key>UILaunchScreen</key><dict/><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>mobileqa</string></array></dict></array></dict></plist>`);
run("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "clang", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios17.0-simulator`, "-fobjc-arc", "-framework", "UIKit", "-framework", "Foundation", source, "-o", join(app, "MobileQA")]);
const available = JSON.parse(run("/usr/bin/xcrun", ["simctl", "list", "runtimes", "--json"])).runtimes;
const runtime = available.find((runtime) => runtime.isAvailable && runtime.identifier.includes(".iOS-"));
assert.ok(runtime, "Install an iOS simulator runtime in Xcode first");
const name = `Dure Mobile QA ${randomUUID()}`;
const id = run("/usr/bin/xcrun", ["simctl", "create", name, "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime.identifier]).trim();
writeFileSync(join(root, "ownership.json"), JSON.stringify({ root, id, name, runtime: runtime.identifier, cwd: process.cwd() }, null, 2));
const url = `index.html?qaWindowSmokeController=1&qaMobileSimulator=${encodeURIComponent(id)}&fixture=${Buffer.from(app).toString("base64url")}`;
console.log("Disposable simulator ownership:", join(root, "ownership.json"));
// The managed parent can pin its live backend binary. QA builds its own source.
const environment = { ...process.env };
for (const key of ["DURE_CONTROL_PLANE_BIN", "DURE_CLAUDE_PROCESS_RELAY_BIN", "CARGO_TARGET_DIR"]) delete environment[key];
try {
 const child = spawn("sh", ["scripts/qa/lib/tauri-app-runner.sh"], {
  stdio: "inherit",
  env: { ...environment, SHELL: "/bin/zsh", DURE_QA_HOME_SETUP: resolve("scripts/qa/mobile-simulator-home-setup.mjs"), DURE_QA_MOBILE_DEVICE: id, DURE_QA_CLIENT: resolve("scripts/qa/mobile-simulator-client.mjs"), DURE_QA_NAME: "Native mobile simulator", DURE_QA_ARTIFACT_NAME: "mobile-simulator", DURE_QA_LAYER: "background", DURE_QA_UNIQUE_APP_CHANNEL: "1", DURE_QA_WINDOW_URL: url,
   DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([{ label: "main", title: "Dure Mobile Simulator QA", url, width: 560, height: 950, x: -4000, y: -2000, visible: true, focus: false, focusable: false }]) },
 });
 process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
} finally {
 const devices = Object.values(JSON.parse(run("/usr/bin/xcrun", ["simctl", "list", "devices", "--json"])).devices).flat();
 const owned = devices.find((device) => device.udid === id);
 assert.equal(owned?.name, name, "Simulator ownership changed; refusing cleanup");
 if (owned.state !== "Shutdown") run("/usr/bin/xcrun", ["simctl", "shutdown", id]);
 run("/usr/bin/xcrun", ["simctl", "delete", id]);
}
