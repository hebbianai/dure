//! Attach to a session on another machine and print what it is showing.
//!
//! This is the smallest complete thing that proves the design: it opens an SSH
//! exec channel, runs the real Hmux handshake through the client's transport
//! seam, and writes the session's terminal bytes to stdout. No phone, no Xcode,
//! no app.
//!
//! ```text
//! HMUX_ATTACH_SECRET=... cargo run --example ssh_attach -- \
//!     --host 127.0.0.1 --user "$USER" \
//!     --identity ~/.ssh/id_ed25519 \
//!     --host-key SHA256:... \
//!     --fence-file ./fence.json \
//!     --seconds 10
//! ```
//!
//! `--command` defaults to `hmux mobile-gateway`, the same invocation the
//! pairing flow installs as an SSH forced command. The example therefore
//! exercises the real gateway when the remote account has a current Hmux
//! install; stderr preserves failures such as an absent install or refused
//! fence without mixing them into the terminal byte stream on stdout.
//!
//! Two argument choices are about credentials rather than ergonomics. The attach
//! secret is read from the environment, never `--attach-secret`, because argv is
//! world-readable through `ps`. The host key must be pinned; there is no
//! "accept anything" flag, because a relay carries a session's entire input
//! stream and accepting whoever answers the address hands that stream to
//! whoever answers the address. On first run, pass a deliberately wrong
//! fingerprint: the refusal names the one the host actually offered.

use hmux_ssh_transport::{
    AttachReplay, HostKeyPolicy, LocalAttachRole, OutputBudget, ReconnectCursor, RemoteAttach,
    SessionFence, SshAuthentication, SshEndpoint, SshExecConfig, attach_over_ssh,
    describe_attestation, relay_output,
};
use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("ssh_attach: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    if arguments.contains_key("help") {
        eprintln!("{USAGE}");
        return Ok(());
    }

    let host = required(&arguments, "host")?;
    let user = required(&arguments, "user")?;
    let host_key = required(&arguments, "host-key")?;
    let identity = required(&arguments, "identity")?;
    let fence_file = required(&arguments, "fence-file")?;
    let reconnect_cursor = arguments
        .get("cursor-in")
        .map(|path| read_json::<ReconnectCursor>(path, "reconnect cursor"))
        .transpose()?;

    let attach_secret = std::env::var("HMUX_ATTACH_SECRET").map_err(|_| {
        "set HMUX_ATTACH_SECRET; it is not an argument because argv is visible in `ps`".to_string()
    })?;

    let fence: SessionFence = serde_json::from_str(
        &std::fs::read_to_string(&fence_file)
            .map_err(|error| format!("could not read {fence_file}: {error}"))?,
    )
    .map_err(|error| format!("{fence_file} is not a session fence: {error}"))?;

    let openssh_pem = std::fs::read_to_string(&identity)
        .map_err(|error| format!("could not read {identity}: {error}"))?;

    let role = match arguments.get("role").map(String::as_str) {
        None | Some("observer") => LocalAttachRole::Observer,
        Some("controller") => LocalAttachRole::Controller,
        // `shared-writer` is deliberately absent. It asks the Host for
        // `shared_terminal_input`, which is one of the three privileges premised
        // on colocation, so the client refuses the attach after a successful
        // handshake. Offering the flag would only produce a confusing failure.
        Some(other) => return Err(format!("unknown role {other}; use observer or controller")),
    };

    let mut ssh = SshExecConfig::new(
        SshEndpoint {
            host: host.clone(),
            port: parse_number(&arguments, "port")?.unwrap_or(22) as u16,
        },
        user,
        SshAuthentication::PrivateKey {
            openssh_pem,
            passphrase: std::env::var("HMUX_IDENTITY_PASSPHRASE").ok(),
        },
        HostKeyPolicy::pinned([host_key]),
    );
    if let Some(command) = arguments.get("command") {
        ssh.command.clone_from(command);
    }

    eprintln!("ssh_attach: exec `{}` on {host}", ssh.command);
    let mut connection = attach_over_ssh(
        ssh,
        RemoteAttach {
            fence,
            attach_secret,
            role,
            reconnect_cursor,
        },
    )
    .map_err(|error| format!("[{}] {error}", error.code()))?;

    if let Some(expected) = arguments.get("expect-replay") {
        let actual = replay_name(connection.attach_replay());
        if actual != expected {
            return Err(format!("attach replay was {actual}, expected {expected}"));
        }
    }
    // Printed to stderr so stdout stays exactly the session's bytes: this is
    // meant to be pipeable, and a terminal stream with commentary spliced into
    // it is not a terminal stream.
    eprintln!(
        "ssh_attach: attached — transport is {}",
        describe_attestation(connection.attestation())
    );
    eprintln!(
        "ssh_attach: host granted {:?}",
        connection.hello_ack().selected_capabilities
    );

    let budget = OutputBudget {
        duration: parse_number(&arguments, "seconds")?.map(Duration::from_secs),
        frames: parse_number(&arguments, "frames")?.map(|frames| frames as usize),
    };
    let mut stdout = std::io::stdout().lock();
    let receipt = relay_output(&mut connection, &mut stdout, budget)
        .map_err(|error| format!("[{}] {error}", error.code()))?;
    stdout.flush().map_err(|error| error.to_string())?;
    if let Some(path) = arguments.get("cursor-out") {
        // `reconnect_cursor` advances when a frame is handed to this process.
        // Publish it only after the same bytes have reached the sink. If output
        // fails or the process dies between those steps, retaining the older
        // cursor can duplicate output on reconnect but cannot silently skip it.
        write_json(path, &receipt.applied_cursor, "reconnect cursor")?;
    }
    eprintln!("\nssh_attach: {:?}", receipt.stop);
    Ok(())
}

const USAGE: &str = "\
usage: ssh_attach --host H --user U --identity PATH --host-key SHA256:... \\
                  --fence-file PATH [--port N] [--command CMD]
                  [--role observer|controller] [--seconds N] [--frames N]
                  [--cursor-in PATH] [--cursor-out PATH]
                  [--expect-replay snapshot|snapshot-after-gap|resumed]

  HMUX_ATTACH_SECRET      required; the bearer credential sent in Hello
  HMUX_IDENTITY_PASSPHRASE optional; passphrase for --identity

  --fence-file  JSON SessionFence. Required in full because every field is
                compared exactly and no remote session discovery exists yet.
  --cursor-in   JSON ReconnectCursor last applied before a transport drop.
  --cursor-out  Atomically persist the last cursor flushed to stdout when the
                relay stops, including after a clean transport drop.
  --expect-replay
                Fail unless the Host seeds the attach in the named way.
  --host-key    SHA256 fingerprint. Pinning is the only mode; pass a wrong one
                once and the refusal reports what the host actually offered.";

fn read_json<T: serde::de::DeserializeOwned>(path: &str, description: &str) -> Result<T, String> {
    serde_json::from_str(
        &std::fs::read_to_string(path)
            .map_err(|error| format!("could not read {description} {path}: {error}"))?,
    )
    .map_err(|error| format!("{path} is not a {description}: {error}"))
}

fn write_json<T: serde::Serialize>(path: &str, value: &T, description: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("could not encode {description}: {error}"))?;
    let destination = std::path::Path::new(path);
    let temporary = destination.with_extension(format!("tmp.{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("could not create {description} {path}: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("could not write {description} {path}: {error}"));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("could not publish {description} {path}: {error}"));
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync {description} directory {path}: {error}"))?;
    Ok(())
}

fn replay_name(replay: &AttachReplay) -> &'static str {
    match replay {
        AttachReplay::Snapshot => "snapshot",
        AttachReplay::SnapshotAfterGap(_) => "snapshot-after-gap",
        AttachReplay::Resumed { .. } => "resumed",
        AttachReplay::TerminalViewportFrame => "terminal-viewport-frame",
    }
}

fn parse_arguments() -> Result<HashMap<String, String>, String> {
    let mut parsed = HashMap::new();
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        let Some(name) = argument.strip_prefix("--") else {
            return Err(format!("unexpected argument {argument}\n\n{USAGE}"));
        };
        if name == "help" {
            parsed.insert("help".to_string(), String::new());
            continue;
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("--{name} needs a value\n\n{USAGE}"))?;
        parsed.insert(name.to_string(), value);
    }
    Ok(parsed)
}

fn required(arguments: &HashMap<String, String>, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .cloned()
        .ok_or_else(|| format!("--{name} is required\n\n{USAGE}"))
}

fn parse_number(arguments: &HashMap<String, String>, name: &str) -> Result<Option<u64>, String> {
    arguments
        .get(name)
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("--{name}: {error}"))
        })
        .transpose()
}
