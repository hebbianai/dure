//! What the person turned on, so a restart does not quietly undo it.
//!
//! The hub listens on the network, so it starts only when somebody asks — and
//! that has always been true of *starting* it. What was missing is that the
//! asking did not survive the process: every app restart left a paired phone
//! talking to a computer that, from its side, had simply gone offline. Nothing
//! on either screen said why, because from the laptop's point of view nothing
//! had failed.
//!
//! So this records the choice, not the state. It is written when somebody turns
//! the hub on and erased when they turn it off — which is the whole reason it
//! can be replayed without asking again: replaying it opens nothing the person
//! did not already open.
//!
//! The relay endpoint rides along for the same reason. A hub that comes back
//! without its relay registration is reachable on the desk and nowhere else,
//! and "my phone works at home but not outside" is a worse failure than the one
//! this file exists to remove.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The record's own version. A file this build cannot read is treated as no
/// record at all — a hub that fails to come back is recoverable with one press;
/// one that comes back from a misread file is not explainable at all.
const AUTOSTART_VERSION: u16 = 1;

const FILE_NAME: &str = "hub-autostart.json";

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct Autostart {
    pub(crate) hub_autostart_version: u16,
    /// The address the person chose for the hub to advertise.
    pub(crate) address: String,
    /// Set only while the relay was also on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) relay_endpoint: Option<String>,
}

#[must_use]
pub(crate) fn path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

/// What to bring back, if anything.
///
/// Every failure reads as "nothing to bring back". A hub that stays off is one
/// press away; a hub started from a file this build could not parse is a
/// listening socket nobody asked for.
#[must_use]
pub(crate) fn load(root: &Path) -> Option<Autostart> {
    let bytes = std::fs::read(path(root)).ok()?;
    let record: Autostart = serde_json::from_slice(&bytes).ok()?;
    if record.hub_autostart_version != AUTOSTART_VERSION || record.address.trim().is_empty() {
        return None;
    }
    Some(record)
}

/// Remember that the hub is on, at this address.
///
/// Keeps whatever relay endpoint was already recorded: turning the hub on again
/// is not a statement about the relay.
pub(crate) fn remember_hub(root: &Path, address: &str) -> std::io::Result<()> {
    let previous = load(root);
    write(
        root,
        &Autostart {
            hub_autostart_version: AUTOSTART_VERSION,
            address: address.to_string(),
            relay_endpoint: previous.and_then(|record| record.relay_endpoint),
        },
    )
}

/// Remember that the relay is registered, at this endpoint.
///
/// Does nothing when the hub itself is not recorded: the relay cannot be the
/// only thing remembered, because it can only be started after the hub.
pub(crate) fn remember_relay(root: &Path, endpoint: &str) -> std::io::Result<()> {
    let Some(record) = load(root) else {
        return Ok(());
    };
    write(
        root,
        &Autostart {
            relay_endpoint: Some(endpoint.to_string()),
            ..record
        },
    )
}

/// The person turned the hub off. Forget all of it — the relay cannot outlive
/// the hub it depends on.
pub(crate) fn forget(root: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path(root)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The person turned the relay off and left the hub on.
pub(crate) fn forget_relay(root: &Path) -> std::io::Result<()> {
    let Some(record) = load(root) else {
        return Ok(());
    };
    write(
        root,
        &Autostart {
            relay_endpoint: None,
            ..record
        },
    )
}

fn write(root: &Path, record: &Autostart) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    std::fs::write(path(root), bytes)
}

/// The address to bring the hub back on.
///
/// The recorded one when this machine still has it, and otherwise the best one
/// it has now. A remembered address can simply stop existing — a different
/// Wi-Fi, a VPN that was not up yet at login — and refusing to start there
/// would turn "always on" into "on until the network changes", which is the
/// failure this whole record exists to remove.
///
/// Substituting is safe because the address is only where the hub *listens*.
/// The phone finds it through the relay or through what the pairing QR gave it;
/// nothing about trust or identity is carried here — the certificate and the
/// device tokens are unchanged.
#[must_use]
pub(crate) fn address_to_resume(
    recorded: &str,
    available: &[crate::mobile_pairing::NetworkChoice],
) -> Option<String> {
    if available.iter().any(|choice| choice.address == recorded) {
        return Some(recorded.to_string());
    }
    // `network_choices` already puts tailnet addresses first, and those are the
    // ones that survive a move between networks — exactly what a hub that is
    // meant to stay on should prefer.
    available.first().map(|choice| choice.address.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hub_that_was_turned_on_is_remembered() {
        let root = tempfile::tempdir().unwrap();

        remember_hub(root.path(), "100.64.0.1").unwrap();

        assert_eq!(
            load(root.path()),
            Some(Autostart {
                hub_autostart_version: AUTOSTART_VERSION,
                address: "100.64.0.1".to_string(),
                relay_endpoint: None,
            })
        );
    }

    /// 켠 것을 기억하는 것이지 켜져 있던 것을 기억하는 게 아니다 — 사람이 끄면
    /// 그 선택도 그대로 남아야 한다.
    #[test]
    fn turning_it_off_is_remembered_as_off() {
        let root = tempfile::tempdir().unwrap();
        remember_hub(root.path(), "100.64.0.1").unwrap();

        forget(root.path()).unwrap();

        assert_eq!(load(root.path()), None);
    }

    /// 릴레이는 허브 위에서만 산다. 허브를 끄면 릴레이 기억도 같이 없어져야
    /// 하고, 그러지 않으면 다음 부팅이 "허브 없이 릴레이만" 을 시도한다.
    #[test]
    fn forgetting_the_hub_forgets_its_relay() {
        let root = tempfile::tempdir().unwrap();
        remember_hub(root.path(), "100.64.0.1").unwrap();
        remember_relay(root.path(), "relay.example:8787").unwrap();

        forget(root.path()).unwrap();

        assert_eq!(load(root.path()), None);
    }

    #[test]
    fn the_relay_can_be_turned_off_without_the_hub() {
        let root = tempfile::tempdir().unwrap();
        remember_hub(root.path(), "100.64.0.1").unwrap();
        remember_relay(root.path(), "relay.example:8787").unwrap();

        forget_relay(root.path()).unwrap();

        let record = load(root.path()).expect("허브는 켜진 채로 남는다");
        assert_eq!(record.address, "100.64.0.1");
        assert_eq!(record.relay_endpoint, None);
    }

    /// 허브 없이 릴레이만 기억되는 상태는 만들 수 없다.
    #[test]
    fn the_relay_alone_is_not_a_record() {
        let root = tempfile::tempdir().unwrap();

        remember_relay(root.path(), "relay.example:8787").unwrap();

        assert_eq!(load(root.path()), None);
    }

    fn choice(address: &str, tailnet: bool) -> crate::mobile_pairing::NetworkChoice {
        crate::mobile_pairing::NetworkChoice {
            address: address.to_string(),
            interface: if tailnet { "utun4" } else { "en0" }.to_string(),
            tailnet,
        }
    }

    #[test]
    fn the_recorded_address_wins_while_it_still_exists() {
        let available = [choice("100.64.0.1", true), choice("192.168.0.5", false)];

        assert_eq!(
            address_to_resume("192.168.0.5", &available),
            Some("192.168.0.5".to_string())
        );
    }

    /// 기억한 주소가 사라지는 일은 흔하다 — 다른 와이파이, 로그인 시점엔 아직
    /// 안 올라온 VPN. 거기서 포기하면 "항상 켜짐" 이 "네트워크가 바뀌기 전까지"
    /// 가 된다.
    #[test]
    fn a_vanished_address_falls_back_to_the_best_one_now() {
        let available = [choice("100.64.0.1", true), choice("192.168.0.5", false)];

        assert_eq!(
            address_to_resume("10.0.0.9", &available),
            Some("100.64.0.1".to_string())
        );
    }

    /// 주소가 하나도 없으면 켤 곳이 없다. 지어내지 않는다.
    #[test]
    fn no_address_means_no_hub() {
        assert_eq!(address_to_resume("10.0.0.9", &[]), None);
    }

    /// 읽을 수 없는 기록은 기록이 없는 것과 같다. 아무도 요청하지 않은 포트를
    /// 여느니 한 번 더 누르게 하는 편이 낫다.
    #[test]
    fn an_unreadable_record_brings_nothing_back() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(path(root.path()), b"{ not json").unwrap();
        assert_eq!(load(root.path()), None);

        std::fs::write(
            path(root.path()),
            br#"{"hub_autostart_version":2,"address":"100.64.0.1"}"#,
        )
        .unwrap();
        assert_eq!(load(root.path()), None);

        std::fs::write(
            path(root.path()),
            br#"{"hub_autostart_version":1,"address":"   "}"#,
        )
        .unwrap();
        assert_eq!(load(root.path()), None);
    }
}
