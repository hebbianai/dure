//! TEMPORARY verification driver — delete after the lab run.
//!
//! Drives exactly what the `take_session_census` command drives — the same
//! `census::take_census` scheduler over the same `relay::list_sessions_within`
//! probe — against a mix of servers that a phone actually meets:
//!
//! - one real sshd with a real hmux session behind a `--list` forced command,
//! - one real sshd whose forced command is not hmux at all (the "no hmux on
//!   this box" case, which must classify as *not provisioned*),
//! - one address nothing is listening on (unreachable),
//! - one server with no stored key (not configured).
//!
//! The point is the classification and the "nobody disappears" property, which
//! unit tests can only show against a fake probe.

use dure_mobile_lib::census::{self, CensusTarget, ProbeOutcome};
use dure_mobile_lib::identity_store::{self, KeyRole};
use dure_mobile_lib::relay::{self, RelayTarget};
use std::time::Duration;

struct Lab {
    id: &'static str,
    label: &'static str,
    port: u16,
    /// `None` means "store no key for this one".
    key: Option<String>,
}

fn main() {
    let mut arguments = std::env::args().skip(1);
    let keys = arguments.next().expect("key root");
    let fingerprint = arguments.next().expect("SHA256:… fingerprint");
    let user = arguments.next().expect("user");
    let good_port: u16 = arguments
        .next()
        .expect("port of the hmux server")
        .parse()
        .unwrap();
    let bare_port: u16 = arguments
        .next()
        .expect("port of the hmux-less server")
        .parse()
        .unwrap();
    let dead_port: u16 = arguments
        .next()
        .expect("a port nothing listens on")
        .parse()
        .unwrap();
    let pem_path = arguments.next().expect("client PEM");
    let pem = std::fs::read_to_string(&pem_path).expect("read the lab PEM");

    let labs = [
        Lab {
            id: "good",
            label: "hmux 있는 서버",
            port: good_port,
            key: Some(pem.clone()),
        },
        Lab {
            id: "bare",
            label: "hmux 없는 서버",
            port: bare_port,
            key: Some(pem.clone()),
        },
        Lab {
            id: "dead",
            label: "꺼진 서버",
            port: dead_port,
            key: Some(pem),
        },
        Lab {
            id: "keyless",
            label: "키 없는 서버",
            port: good_port,
            key: None,
        },
    ];

    for lab in &labs {
        if let Some(pem) = &lab.key {
            identity_store::store(keys.as_ref(), lab.id, KeyRole::List, pem).expect("store");
        }
    }

    let targets: Vec<CensusTarget> = labs
        .iter()
        .map(|lab| CensusTarget {
            server_id: lab.id.to_string(),
            server_label: lab.label.to_string(),
        })
        .collect();

    let reports = census::take_census(
        &targets,
        census::MAX_PARALLEL_SERVERS,
        census::CENSUS_BUDGET,
        |target| {
            let lab = labs
                .iter()
                .find(|lab| lab.id == target.server_id)
                .expect("lab");
            let target = RelayTarget {
                host: "127.0.0.1".to_string(),
                port: lab.port,
                username: user.clone(),
                host_key_fingerprint: fingerprint.clone(),
            };
            let key = match identity_store::load(keys.as_ref(), lab.id, KeyRole::List) {
                Ok(key) => key,
                Err(error) => {
                    return ProbeOutcome::NotConfigured {
                        code: "identity_missing".to_string(),
                        detail: error.to_string(),
                    }
                }
            };
            match relay::ssh_config(&target, key, None, relay::gateway_command())
                .and_then(|config| relay::list_sessions_within(config, Duration::from_secs(8)))
            {
                Ok(listing) => ProbeOutcome::Listed {
                    forced_command_applied: listing.forced_command_applied,
                    sessions: listing.sessions.into_iter().map(Into::into).collect(),
                },
                Err(error) => census::classify(&error),
            }
        },
    );

    println!(
        "== {} report(s) for {} server(s)",
        reports.len(),
        labs.len()
    );
    for report in &reports {
        match &report.outcome {
            ProbeOutcome::Listed {
                sessions,
                forced_command_applied,
            } => println!(
                "  {:<16} LISTED forced_command={:?} {} session(s): {:?}",
                report.server_label,
                forced_command_applied,
                sessions.len(),
                sessions
                    .iter()
                    .map(|session| session.session.session_id.as_str())
                    .collect::<Vec<_>>()
            ),
            ProbeOutcome::NotProvisioned { detail } => {
                println!("  {:<16} NOT_PROVISIONED {detail}", report.server_label);
            }
            ProbeOutcome::NotConfigured { code, detail } => {
                println!(
                    "  {:<16} NOT_CONFIGURED [{code}] {detail}",
                    report.server_label
                );
            }
            ProbeOutcome::Unreachable { code, detail } => {
                println!(
                    "  {:<16} UNREACHABLE [{code}] {detail}",
                    report.server_label
                );
            }
            ProbeOutcome::TimedOut { seconds } => {
                println!("  {:<16} TIMED_OUT after {seconds}s", report.server_label);
            }
            ProbeOutcome::NotAttempted => {
                println!("  {:<16} NOT_ATTEMPTED", report.server_label);
            }
        }
    }
}
