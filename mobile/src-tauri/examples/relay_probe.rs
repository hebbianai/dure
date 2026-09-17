//! Real-transport verification driver for the mobile TerminalSurface path.
//!
//! Drives exactly the code paths the Tauri commands drive (`identity_store`,
//! `relay::ssh_config`, `relay::list_sessions`, `relay::open_terminal_surface`)
//! against a real sshd + real gateway + real session.

use dure_mobile_lib::identity_store::{self, KeyRole};
use dure_mobile_lib::relay::{self, RelayTarget};
use hmux_client::TerminalSurfaceAccess;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let keys = arguments.next().expect("key root");
    let fingerprint = arguments.next().expect("SHA256:… fingerprint");
    let user = arguments.next().expect("user");
    // Not hardcoded: this machine runs several agents' loopback sshd lab
    // instances at once, so the port a run gets is whichever one was free.
    let port: u16 = arguments
        .next()
        .map_or(22223, |value| value.parse().expect("port must be a number"));

    let target = RelayTarget {
        host: "127.0.0.1".to_string(),
        port,
        username: user,
        host_key_fingerprint: fingerprint,
    };

    // The keys are *stored* through the app's own writer before they are read
    // back, rather than dropped into the directory under a hand-computed file
    // name. The store hashes the server id to name the file, so placing files
    // by hand means reimplementing that hash in the harness — which is a
    // second implementation that can disagree with the first, and it did:
    // the first lab run failed with `Missing` against two key files that were
    // sitting right there. Round-tripping through `store` also means this
    // probe covers the same write path the UI's "save identity" command uses.
    for (role, variable) in [
        (KeyRole::Attach, "LAB_ATTACH_KEY"),
        (KeyRole::List, "LAB_LIST_KEY"),
    ] {
        if let Ok(path) = std::env::var(variable) {
            let pem = std::fs::read_to_string(&path).expect("read the lab PEM");
            identity_store::store(keys.as_ref(), "lab", role, &pem).expect("store the lab key");
        }
    }

    let list_key = identity_store::load(keys.as_ref(), "lab", KeyRole::List).expect("list key");
    let config = relay::ssh_config(&target, list_key, None, relay::gateway_command())
        .expect("list ssh config");
    let listing = match relay::list_sessions(config) {
        Ok(sessions) => sessions,
        Err(error) => {
            eprintln!("LIST FAILED [{}] {error}", error.code());
            std::process::exit(1);
        }
    };
    // 관측된 사실도 찍는다 — 이 프로브의 용도가 바로 두 서버의 차이를 눈으로
    // 보는 것이고, Tailscale 호스트에서 false 가 나오는 것이 이 필드의 존재 이유다.
    println!(
        "== forced_command_applied={:?} ==",
        listing.forced_command_applied
    );
    let sessions = listing.sessions;
    println!("== discovered {} session(s) ==", sessions.len());
    for session in &sessions {
        println!(
            "  {} name={:?} ws={} class={} lifecycle={} ready={} fence={:?}",
            session.session_id,
            session.session_name,
            session.workspace_id,
            session.session_class.as_str(),
            session.lifecycle.as_str(),
            session.is_ready(),
            session.fence().expect("fence")
        );
    }

    let session = sessions.first().expect("at least one session").clone();
    let attach_key =
        identity_store::load(keys.as_ref(), "lab", KeyRole::Attach).expect("attach key");
    let config = relay::ssh_config(&target, attach_key, None, relay::gateway_command())
        .expect("attach ssh config");
    let attachment =
        match relay::open_terminal_surface(config, &session, TerminalSurfaceAccess::ReadOnly) {
            Ok(attachment) => attachment,
            Err(error) => {
                eprintln!("ATTACH FAILED [{}] {error}", error.code());
                std::process::exit(1);
            }
        };
    println!("== attached: attestation = {}", attachment.attestation);
    println!(
        "== granted capabilities = {:?}",
        attachment.surface.selected_capabilities()
    );
    let frame = attachment.surface.current_frame();
    println!(
        "== viewport frame epoch={} revision={} output={} initial-records={} ==",
        frame.terminal_epoch(),
        frame.state_revision(),
        frame.through_output_seq(),
        attachment.surface.initial_delivery_records().len(),
    );
}
