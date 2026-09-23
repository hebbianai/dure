import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildAndroidFixture(root, sdk) {
 const tools = join(sdk, "build-tools/35.0.0");
 const android = join(sdk, "platforms/android-35/android.jar");
 const run = (binary, args) => execFileSync(binary, args, { timeout: 120_000, stdio: "pipe" });
 const classes = join(root, "classes"); mkdirSync(classes);
 const source = join(root, "Main.java");
 writeFileSync(source, `package com.dure.mobileqa;
import android.app.Activity; import android.os.Bundle; import android.view.*; import android.graphics.*; import android.util.Log;
public class Main extends Activity {
 public void onCreate(Bundle state) { super.onCreate(state); setContentView(new Screen()); Log.i("DureMobileQA", "launched"); Log.i("DureMobileQA", "link:" + getIntent().getDataString()); }
 class Screen extends View {
  int touches = 0;
  Screen() { super(Main.this); setFocusableInTouchMode(true); requestFocus(); }
  protected void onDraw(Canvas canvas) { canvas.drawColor(Color.rgb(25, 89, 166)); Paint p = new Paint(); p.setColor(Color.WHITE); p.setTextSize(48); canvas.drawText("Dure Android QA " + touches, 30, 160, p); }
  public boolean onTouchEvent(MotionEvent event) { if(event.getAction() == MotionEvent.ACTION_DOWN) { touches++; Log.i("DureMobileQA", "touch:" + touches); invalidate(); } return true; }
  public boolean onKeyDown(int code, KeyEvent event) { Log.i("DureMobileQA", "key:" + event.getUnicodeChar()); Log.i("DureMobileQA", "keycode:" + code); return true; }
 }
}`);
 const manifest = join(root, "AndroidManifest.xml");
 writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.dure.mobileqa"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><application android:label="Dure Android QA" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name=".Main" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter><intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="mobileqa"/></intent-filter></activity></application></manifest>`);
 run("javac", ["-source", "8", "-target", "8", "-classpath", android, "-d", classes, source]);
 const jar = join(root, "classes.jar"); run("jar", ["cf", jar, "-C", classes, "."]);
 run(join(tools, "d8"), ["--lib", android, "--output", root, jar]);
 const apk = join(root, "MobileQA.apk");
 run(join(tools, "aapt2"), ["link", "-o", apk, "--manifest", manifest, "-I", android]);
 execFileSync("zip", ["-j", apk, join(root, "classes.dex")], { timeout: 10000 });
 const key = join(root, "qa.jks");
 run("keytool", ["-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android", "-alias", "qa", "-dname", "CN=Dure QA", "-keyalg", "RSA", "-validity", "2", "-noprompt"]);
 run(join(tools, "apksigner"), ["sign", "--ks", key, "--ks-pass", "pass:android", apk]);
 return apk;
}
