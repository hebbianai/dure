export function browserEnvironment(command, values, options) {
  if (command === "set") [command, ...values] = values;
  const namedCredentials = options.user !== undefined || options.pass !== undefined;
  if (["credentials", "auth"].includes(command)) {
    const reset = values.length === 1 && values[0] === "reset" && !namedCredentials;
    if (namedCredentials && (values.length || options.user === undefined || options.pass === undefined)) throw new Error("browser_credentials_invalid");
    const credentials = namedCredentials ? [options.user, options.pass] : values;
    if (!reset && (credentials.length !== 2 || credentials[0].includes(":") || credentials.some((value) => /[\x00-\x1f\x7f]/.test(value)) || credentials.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 48 * 1024)) throw new Error("browser_credentials_invalid");
    // Basic credentials replace the same extra-header map as `headers`.
    // Normalize into its existing typed action instead of another state writer.
    command = "headers";
    values = [JSON.stringify(reset ? {} : { authorization: `Basic ${Buffer.from(credentials.join(":"), "utf8").toString("base64")}` })];
  } else if (namedCredentials) throw new Error("browser_credentials_invalid");
  const number = (value) => {
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) throw new Error("browser_environment_invalid");
    return Number(value);
  };
  const emulationOptions = ["scale", "mobile", "colorScheme", "reducedMotion"];
  if (!["viewport", "media"].includes(command) && emulationOptions.some((key) => options[key] !== undefined)) throw new Error("browser_environment_invalid");
  if (command !== "geo" && options.accuracy !== undefined) throw new Error("browser_environment_invalid");
  let action;
  if (command === "viewport") {
    if (options.colorScheme !== undefined || options.reducedMotion !== undefined) throw new Error("browser_environment_invalid");
    if (values.length === 1 && values[0] === "reset") {
      if (options.scale !== undefined || options.mobile !== undefined) throw new Error("browser_environment_invalid");
      action = { kind: "viewport_reset" };
    } else {
      if (values.length !== 2) throw new Error("browser_environment_invalid");
      const [width, height] = values.map(number);
      const scale = number(options.scale ?? "1");
      if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 65535) || scale < 0.1 || scale > 8 || width * height * scale * scale > 16_000_000) throw new Error("browser_viewport_invalid");
      action = { kind: "viewport", width, height, scale, mobile: options.mobile ?? false };
    }
  } else if (command === "device") {
    if (values.length !== 1 || !values[0] || Buffer.byteLength(values[0]) > 128 || /[\x00-\x1f\x7f]/.test(values[0])) throw new Error("browser_device_invalid");
    action = values[0] === "reset" ? { kind: "device_reset" } : { kind: "device", name: values[0] };
  } else if (command === "media") {
    const preferencesOnly = values.length === 0 && (options.colorScheme !== undefined || options.reducedMotion !== undefined);
    if ((!preferencesOnly && (values.length !== 1 || !["screen", "print", "reset"].includes(values[0]))) || options.scale !== undefined || options.mobile !== undefined) throw new Error("browser_environment_invalid");
    if (values[0] === "reset" && (options.colorScheme !== undefined || options.reducedMotion !== undefined)) throw new Error("browser_environment_invalid");
    if (options.colorScheme !== undefined && !["light", "dark", "no-preference"].includes(options.colorScheme)) throw new Error("browser_environment_invalid");
    if (options.reducedMotion !== undefined && !["reduce", "no-preference"].includes(options.reducedMotion)) throw new Error("browser_environment_invalid");
    action = { kind: "media", media: values[0], color_scheme: options.colorScheme, reduced_motion: options.reducedMotion };
  } else if (command === "geo") {
    if (values.length === 1 && ["reset", "unavailable"].includes(values[0])) {
      if (options.accuracy !== undefined) throw new Error("browser_geolocation_invalid");
      action = { kind: values[0] === "reset" ? "geolocation_reset" : "geolocation_unavailable" };
    } else {
      if (values.length !== 2) throw new Error("browser_geolocation_invalid");
      const [latitude, longitude] = values.map(number);
      const accuracy = number(options.accuracy ?? "1");
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy < 0) throw new Error("browser_geolocation_invalid");
      action = { kind: "geolocation", latitude, longitude, accuracy };
    }
  } else if (command === "offline") {
    if (values.length !== 1 || !["on", "off"].includes(values[0])) throw new Error("browser_offline_invalid");
    action = { kind: "offline", offline: values[0] === "on" };
  } else if (command === "headers") {
    if (values.length !== 1) throw new Error("browser_headers_invalid");
    let headers;
    try { headers = values[0] === "reset" ? {} : JSON.parse(values[0]); } catch { throw new Error("browser_headers_invalid"); }
    if (!headers || Array.isArray(headers) || typeof headers !== "object") throw new Error("browser_headers_invalid");
    const entries = Object.entries(headers);
    let bytes = 0;
    const names = new Set();
    for (const [name, value] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== "string" || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error("browser_headers_invalid");
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (bytes > 64 * 1024 || names.has(name.toLowerCase())) throw new Error("browser_headers_invalid");
      names.add(name.toLowerCase());
    }
    action = { kind: "headers", headers: Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), value])) };
  } else if (command === "permission") {
    if (values.length !== 3 || !["geolocation", "clipboard-read", "clipboard-write"].includes(values[0]) || !["granted", "denied", "prompt"].includes(values[1])) throw new Error("browser_permission_invalid");
    let origin;
    try { origin = new URL(values[2]); } catch { throw new Error("browser_permission_origin_invalid"); }
    if (values[2].length > 8192 || !["http:", "https:"].includes(origin.protocol) || !origin.hostname || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("browser_permission_origin_invalid");
    action = { kind: "permission", permission: values[0], setting: values[1], origin: origin.origin };
  } else throw new Error("browser_environment_invalid");
  return { kind: "environment", action };
}
