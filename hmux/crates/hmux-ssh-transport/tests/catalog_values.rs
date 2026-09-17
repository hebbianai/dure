//! Catalog values must retain the same wire meaning at all three consumer edges.

use hmux_client::{ProtocolVersion, SessionClass, VersionRange};
use hmux_session_protocol::discovery::SessionClass as ManifestSessionClass;
use hmux_ssh_transport::{RemoteProtocolVersion, RemoteSessionClass, RemoteVersionRange};
use serde::{Serialize, de::DeserializeOwned};

fn round_trip<T: DeserializeOwned + Serialize>(json: &str) {
    let value: T = serde_json::from_str(json).unwrap();
    let expected: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(serde_json::to_value(value).unwrap(), expected);
}

#[test]
fn manifest_local_and_remote_classes_preserve_values_and_refusals() {
    for json in [r#""managed""#, r#""standalone""#] {
        round_trip::<ManifestSessionClass>(json);
        round_trip::<SessionClass>(json);
        round_trip::<RemoteSessionClass>(json);
    }
    for json in [r#""starting""#, r#""Managed""#, "null", "1"] {
        assert!(serde_json::from_str::<ManifestSessionClass>(json).is_err());
        assert!(serde_json::from_str::<SessionClass>(json).is_err());
        assert!(serde_json::from_str::<RemoteSessionClass>(json).is_err());
    }
}

#[test]
fn all_version_consumers_preserve_numeric_bounds() {
    for json in [
        r#"{"major":1,"minor":0}"#,
        r#"{"major":65535,"minor":65535}"#,
    ] {
        round_trip::<hmux_session_protocol::ProtocolVersion>(json);
        round_trip::<ProtocolVersion>(json);
        round_trip::<RemoteProtocolVersion>(json);
    }
    for json in [
        r#"{"major":65536,"minor":0}"#,
        r#"{"major":1,"minor":-1}"#,
        r#"{"major":"1","minor":0}"#,
        r#"{"major":1}"#,
    ] {
        assert!(serde_json::from_str::<hmux_session_protocol::ProtocolVersion>(json).is_err());
        assert!(serde_json::from_str::<ProtocolVersion>(json).is_err());
        assert!(serde_json::from_str::<RemoteProtocolVersion>(json).is_err());
    }
}

#[test]
fn ranges_preserve_peer_values_without_inventing_a_negotiated_version() {
    // Range selection belongs to negotiation; decoding must not silently clamp
    // or replace a peer's reversed range before that boundary can refuse it.
    for json in [
        r#"{"minimum":{"major":1,"minor":0},"maximum":{"major":1,"minor":9}}"#,
        r#"{"minimum":{"major":2,"minor":0},"maximum":{"major":1,"minor":0}}"#,
    ] {
        round_trip::<hmux_session_protocol::VersionRange>(json);
        round_trip::<VersionRange>(json);
        round_trip::<RemoteVersionRange>(json);
    }
}

#[test]
fn consumer_values_can_reach_negotiation_without_a_conversion() {
    let remote_class: RemoteSessionClass = serde_json::from_str(r#""standalone""#).unwrap();
    let local_class: SessionClass = remote_class;
    let manifest_class: ManifestSessionClass = local_class;
    assert!(manifest_class.is_standalone());

    let remote: RemoteVersionRange = serde_json::from_str(
        r#"{"minimum":{"major":1,"minor":0},"maximum":{"major":1,"minor":9}}"#,
    )
    .unwrap();
    let local: VersionRange = remote;
    let canonical: hmux_session_protocol::VersionRange = local;
    let selected: ProtocolVersion = canonical
        .select_highest(hmux_session_protocol::VersionRange {
            minimum: hmux_session_protocol::PROTOCOL_V1,
            maximum: hmux_session_protocol::ProtocolVersion { major: 1, minor: 3 },
        })
        .unwrap();
    let remote_selected: RemoteProtocolVersion = selected;
    assert_eq!(
        serde_json::to_string(&remote_selected).unwrap(),
        r#"{"major":1,"minor":3}"#
    );
}
