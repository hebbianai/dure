import fs from "node:fs";
import path from "node:path";

// tauri-bundler DmgSettings defaults. The window position falls back to the
// embedded bundle_dmg.sh defaults (WINX=10, WINY=60) when it is not configured.
const DEFAULT_WINDOW_POSITION = Object.freeze({ x: 10, y: 60 });
const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 660, height: 400 });
const DEFAULT_APP_POSITION = Object.freeze({ x: 180, y: 170 });
const DEFAULT_APPLICATION_FOLDER_POSITION = Object.freeze({ x: 480, y: 170 });
const ICON_SIZE = 128;
const TEXT_SIZE = 16;
const ARCH_NAMES = Object.freeze({ arm64: "aarch64", x64: "x64" });
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON Merge Patch (RFC 7396), which is how the Tauri CLI layers the platform
 * file and every --config file over tauri.conf.json. */
export function mergeTauriConfig(base, patch) {
  if (!isObject(patch)) return patch;
  const result = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergeTauriConfig(result[key], value);
  }
  return result;
}

export function loadTauriConfig(tauriDir, configFiles = []) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`release_dmg_config_unreadable: ${file} (${error.message})`);
    }
  };
  let config = read(path.join(tauriDir, "tauri.conf.json"));
  const platformFile = path.join(tauriDir, "tauri.macos.conf.json");
  if (fs.existsSync(platformFile)) config = mergeTauriConfig(config, read(platformFile));
  for (const file of configFiles) config = mergeTauriConfig(config, read(file));
  return config;
}

function point(value, fallback, label, keys) {
  if (value === undefined) return fallback;
  if (!isObject(value) || keys.some((key) => !Number.isInteger(value[key]) || value[key] < 0)) {
    throw new Error(
      `release_dmg_layout_invalid: bundle.macOS.dmg.${label} needs nonnegative integer ${keys.join(" and ")}`,
    );
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

/** The DMG facts tauri-bundler derives from the merged configuration: file
 * names, Finder layout and the files copied into the volume. */
export function releaseDmgSettings(config, { tauriDir, arch = process.arch }) {
  const { productName, version } = isObject(config) ? config : {};
  if (typeof productName !== "string" || !productName.trim() || /[\\/:"\r\n]/.test(productName)) {
    throw new Error("release_dmg_product_name_invalid: productName must be a plain file name");
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(
      `release_dmg_version_unsupported: version must be a literal semantic version, found ${JSON.stringify(version)}`,
    );
  }
  const archName = ARCH_NAMES[arch];
  if (!archName) throw new Error(`release_dmg_arch_unsupported: ${arch}`);
  const bundle = isObject(config.bundle) ? config.bundle : {};
  if (bundle.licenseFile !== undefined) {
    throw new Error(
      "release_dmg_license_unsupported: bundle.licenseFile (a DMG EULA) is not packaged by bundle-release-dmg.mjs",
    );
  }
  const dmg = isObject(bundle.macOS?.dmg) ? bundle.macOS.dmg : {};
  if (dmg.background !== undefined && (typeof dmg.background !== "string" || !dmg.background)) {
    throw new Error("release_dmg_layout_invalid: bundle.macOS.dmg.background must be a file path");
  }
  const icon = Array.isArray(bundle.icon)
    ? bundle.icon.find((entry) => typeof entry === "string" && entry.endsWith(".icns"))
    : undefined;
  const resolve = (file) => (file ? path.resolve(tauriDir, file) : null);
  return Object.freeze({
    productName,
    version,
    arch: archName,
    appName: `${productName}.app`,
    dmgName: `${productName}_${version}_${archName}.dmg`,
    volumeName: productName,
    background: resolve(dmg.background),
    volumeIcon: resolve(icon),
    windowPosition: point(dmg.windowPosition, DEFAULT_WINDOW_POSITION, "windowPosition", ["x", "y"]),
    windowSize: point(dmg.windowSize, DEFAULT_WINDOW_SIZE, "windowSize", ["width", "height"]),
    appPosition: point(dmg.appPosition, DEFAULT_APP_POSITION, "appPosition", ["x", "y"]),
    applicationFolderPosition: point(
      dmg.applicationFolderPosition,
      DEFAULT_APPLICATION_FOLDER_POSITION,
      "applicationFolderPosition",
      ["x", "y"],
    ),
  });
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The Finder layout tauri-bundler's bundle_dmg.sh applies through
 * template.applescript, for the volume whose /Volumes mount basename is argv 1.
 * Unlike the template this script ends on its own: the unbounded wait for
 * Finder's .DS_Store moved to the caller, which owns the deadline. */
export function renderFinderLayoutScript(settings) {
  const { x, y } = settings.windowPosition;
  const { width, height } = settings.windowSize;
  const app = appleScriptString(settings.appName);
  const background = settings.background
    ? appleScriptString(`.background:${path.basename(settings.background)}`)
    : null;
  return [
    "on run argv",
    "  set volumeName to item 1 of argv",
    '  tell application "Finder"',
    "    tell disk volumeName",
    "      open",
    `      set theXOrigin to ${x}`,
    `      set theYOrigin to ${y}`,
    `      set theBottomRightX to ${x + width}`,
    `      set theBottomRightY to ${y + height}`,
    "      tell container window",
    "        set current view to icon view",
    "        set toolbar visible to false",
    "        set statusbar visible to false",
    "        set the bounds to {theXOrigin, theYOrigin, theBottomRightX, theBottomRightY}",
    ...(background ? ["        set position of every item to {theBottomRightX + 100, 100}"] : []),
    "      end tell",
    "      set opts to the icon view options of container window",
    "      tell opts",
    `        set icon size to ${ICON_SIZE}`,
    `        set text size to ${TEXT_SIZE}`,
    "        set arrangement to not arranged",
    "      end tell",
    ...(background ? [`      set background picture of opts to file ${background}`] : []),
    `      set position of item ${app} to {${settings.appPosition.x}, ${settings.appPosition.y}}`,
    `      set the extension hidden of item ${app} to true`,
    `      set position of item "Applications" to {${settings.applicationFolderPosition.x}, ${settings.applicationFolderPosition.y}}`,
    "      close",
    "      open",
    "      delay 1",
    "      tell container window",
    "        set statusbar visible to false",
    "        set the bounds to {theXOrigin, theYOrigin, theBottomRightX - 10, theBottomRightY - 10}",
    "      end tell",
    "    end tell",
    "    delay 1",
    "    tell disk volumeName",
    "      tell container window",
    "        set statusbar visible to false",
    "        set the bounds to {theXOrigin, theYOrigin, theBottomRightX, theBottomRightY}",
    "      end tell",
    "    end tell",
    "    delay 3",
    "  end tell",
    "end run",
    "",
  ].join("\n");
}
