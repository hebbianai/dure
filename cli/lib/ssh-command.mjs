const DECIMAL_PORT = /^(?:[1-9][0-9]{0,4})$/;

function port(value) {
  if (!DECIMAL_PORT.test(value)) return undefined;
  const parsed = Number(value);
  return parsed <= 65_535 ? parsed : undefined;
}

function destination(value, loginUser, explicitPort) {
  if (!value || value.startsWith("-") || value.includes("\0")) return undefined;
  const separator = value.lastIndexOf("@");
  const user = separator > 0 ? value.slice(0, separator) : loginUser;
  let host = separator > 0 ? value.slice(separator + 1) : value;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || host.includes("/") || /\s/.test(host)) return undefined;
  if (user !== undefined && (!user || /\s/.test(user))) return undefined;
  return {
    host,
    ...(user ? { user } : {}),
    ...(explicitPort ? { port: explicitPort } : {}),
  };
}

/**
 * Select only a plain interactive login. Every option with forwarding,
 * command, subsystem, proxy, config, or identity semantics falls back to the
 * system ssh unchanged.
 */
export function parsePlainInteractiveSsh(argv) {
  let index = 0;
  let loginUser;
  let explicitPort;
  let destinationToken;
  let optionsEnded = false;
  while (index < argv.length) {
    const token = argv[index];
    if (!optionsEnded && token === "--") {
      if (destinationToken !== undefined) {
        return { kind: "fallback", reason: "remote_command" };
      }
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && (token === "-p" || token === "-l")) {
      const value = argv[index + 1];
      if (!value) return { kind: "fallback", reason: "missing_option_value" };
      if (token === "-p") {
        explicitPort = port(value);
        if (!explicitPort) return { kind: "fallback", reason: "invalid_port" };
      } else {
        loginUser = value;
      }
      index += 2;
      continue;
    }
    if (!optionsEnded && token.startsWith("-p") && token.length > 2) {
      explicitPort = port(token.slice(2));
      if (!explicitPort) return { kind: "fallback", reason: "invalid_port" };
      index += 1;
      continue;
    }
    if (!optionsEnded && token.startsWith("-l") && token.length > 2) {
      loginUser = token.slice(2);
      index += 1;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) {
      return { kind: "fallback", reason: "unsupported_option" };
    }
    if (destinationToken !== undefined) {
      return { kind: "fallback", reason: "remote_command" };
    }
    destinationToken = token;
    index += 1;
  }
  if (destinationToken === undefined) {
    return { kind: "fallback", reason: "missing_destination" };
  }
  const parsed = destination(destinationToken, loginUser, explicitPort);
  return parsed
    ? { kind: "handoff", destination: parsed }
    : { kind: "fallback", reason: "invalid_destination" };
}
