use async_trait::async_trait;
use futures_util::stream;
use hmux_release_trust::{
    ArtifactTarget, ChannelTrust, ExpectedTarget, ProtocolVersion, ReleaseChannel, ReleaseProof,
    TrustedState, VerifyError, VerifyFailureKind, verify_release,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tough::{Bytes, Transport, TransportError, TransportErrorKind, TransportStream};
use url::Url;

const METADATA_BASE: &str = "https://fixtures.invalid/channel/metadata/";
const TARGETS_BASE: &str = "https://fixtures.invalid/channel/targets/";
const FIXTURE_POLICY_REFERENCE_UNIX_SECONDS: i64 = 2_114_294_400; // 2036-12-31T00:00:00Z

#[derive(Clone, Debug)]
struct FixtureTransport {
    responses: Arc<HashMap<String, Vec<u8>>>,
}

impl FixtureTransport {
    fn from_repository(repository: &Path) -> Self {
        let mut responses = HashMap::new();
        add_directory(&mut responses, &repository.join("metadata"), METADATA_BASE);
        add_directory(&mut responses, &repository.join("targets"), TARGETS_BASE);
        Self {
            responses: Arc::new(responses),
        }
    }

    fn replace(mut self, url: &str, bytes: Vec<u8>) -> Self {
        Arc::make_mut(&mut self.responses).insert(url.to_owned(), bytes);
        self
    }

    fn mutate_target(mut self, triple: &str, mutation: impl FnOnce(&mut Vec<u8>)) -> Self {
        let responses = Arc::make_mut(&mut self.responses);
        let (_, bytes) = responses
            .iter_mut()
            .find(|(url, _)| url.starts_with(TARGETS_BASE) && url.contains(triple))
            .expect("fixture target for triple");
        mutation(bytes);
        self
    }
}

#[async_trait]
impl Transport for FixtureTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        let Some(bytes) = self.responses.get(url.as_str()) else {
            return Err(TransportError::new(
                TransportErrorKind::FileNotFound,
                url.as_str(),
            ));
        };
        Ok(Box::pin(stream::iter([Ok(Bytes::copy_from_slice(bytes))])))
    }
}

fn add_directory(responses: &mut HashMap<String, Vec<u8>>, root: &Path, base: &str) {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).expect("read fixture directory") {
            let entry = entry.expect("fixture directory entry");
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("fixture path below root")
                    .to_string_lossy()
                    .replace('\\', "/");
                responses.insert(format!("{base}{relative}"), fs::read(path).unwrap());
            }
        }
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn repository(name: &str) -> PathBuf {
    fixtures().join(name)
}

fn trust(channel: ReleaseChannel, repository: &Path) -> ChannelTrust {
    ChannelTrust::new_for_fixture(
        channel,
        fs::read(repository.join("metadata/1.root.json")).expect("bootstrap root"),
        Url::parse(METADATA_BASE).unwrap(),
        Url::parse(TARGETS_BASE).unwrap(),
        FIXTURE_POLICY_REFERENCE_UNIX_SECONDS,
    )
    .expect("fixture trust")
}

fn expected(version: &str, target: ArtifactTarget) -> ExpectedTarget {
    let triple = target.as_str();
    ExpectedTarget {
        target_name: format!("{version}+fixture.{triple}.release.tar.gz"),
        destination: target,
        protocol: ProtocolVersion::new(1, 0),
    }
}

fn json_bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .expect("serialized byte array")
        .iter()
        .map(|byte| {
            u8::try_from(byte.as_u64().expect("serialized byte"))
                .expect("serialized byte is in range")
        })
        .collect()
}

fn reseal_proof_state(proof: &mut Value) {
    let state = proof
        .get_mut("trustedState")
        .expect("serialized trusted state");
    let mut digest = Sha256::new();
    for (name, field) in [
        ("root.json", "rootJson"),
        ("timestamp.json", "timestampJson"),
        ("snapshot.json", "snapshotJson"),
        ("targets.json", "targetsJson"),
        ("latest_known_time.json", "latestKnownTimeJson"),
    ] {
        let bytes = json_bytes(&state[field]);
        digest.update(u64::try_from(name.len()).unwrap().to_be_bytes());
        digest.update(name.as_bytes());
        digest.update(u64::try_from(bytes.len()).unwrap().to_be_bytes());
        digest.update(bytes);
    }
    let bootstrap_root_sha256 = state["bootstrapRootSha256"]
        .as_str()
        .expect("serialized bootstrap digest");
    digest.update(
        u64::try_from(bootstrap_root_sha256.len())
            .unwrap()
            .to_be_bytes(),
    );
    digest.update(bootstrap_root_sha256.as_bytes());
    let roots = state["rootChain"]
        .as_array()
        .expect("serialized root chain");
    digest.update(u64::try_from(roots.len()).unwrap().to_be_bytes());
    for root in roots {
        let bytes = json_bytes(root);
        digest.update(u64::try_from(bytes.len()).unwrap().to_be_bytes());
        digest.update(bytes);
    }
    state["integritySha256"] = json!(hex::encode(digest.finalize()));
}

fn replace_proof_metadata(proof: &mut Value, repository: &Path) {
    for (state_field, receipt_field, file_name) in [
        ("timestampJson", "timestampJson", "timestamp.json"),
        ("snapshotJson", "snapshotJson", "1.snapshot.json"),
        ("targetsJson", "targetsJson", "1.targets.json"),
    ] {
        let bytes = fs::read(repository.join("metadata").join(file_name)).unwrap();
        proof["trustedState"][state_field] = json!(bytes);
        proof["receipt"]["trustedMetadataSha256"][receipt_field] =
            json!(hex::encode(Sha256::digest(&bytes)));
    }
    reseal_proof_state(proof);
}

#[tokio::test]
async fn verifies_threshold_root_rotation_and_both_linux_targets() {
    let path = repository("stable-v1");
    let x86 = verify_release(
        trust(ReleaseChannel::Stable, &path),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&path),
    )
    .await
    .expect("x86 release verifies");
    assert_eq!(x86.proof().receipt().root_version, 2);
    assert_eq!(x86.proof().receipt().targets_version, 1);
    assert_eq!(
        x86.proof().receipt().target.target_triple,
        ArtifactTarget::X86_64LinuxMusl
    );
    assert!(fs::metadata(x86.target_path()).unwrap().len() > 0);
    assert!(x86.proof().trusted_state().is_initialized());

    let arm = verify_release(
        trust(ReleaseChannel::Stable, &path),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::Aarch64LinuxMusl),
        FixtureTransport::from_repository(&path),
    )
    .await
    .expect("arm release verifies");
    assert_eq!(
        arm.proof().receipt().target.target_triple,
        ArtifactTarget::Aarch64LinuxMusl
    );
}

#[tokio::test]
async fn advances_in_staging_then_rejects_metadata_rollback() {
    let v1_path = repository("stable-v1");
    let v1 = verify_release(
        trust(ReleaseChannel::Stable, &v1_path),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&v1_path),
    )
    .await
    .expect("v1 verifies");

    let v2_path = repository("stable-v2");
    let v2 = verify_release(
        trust(ReleaseChannel::Stable, &v2_path),
        v1.proof().trusted_state(),
        &expected("0.1.5", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&v2_path),
    )
    .await
    .expect("v2 verifies");
    assert_eq!(v2.proof().receipt().timestamp_version, 2);
    assert_eq!(v2.proof().receipt().snapshot_version, 2);
    assert_eq!(v2.proof().receipt().targets_version, 2);

    let state_before_failure = v2.proof().trusted_state().clone();
    let error = verify_release(
        trust(ReleaseChannel::Stable, &v1_path),
        v2.proof().trusted_state(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&v1_path),
    )
    .await
    .expect_err("metadata rollback fails");
    assert!(matches!(error, VerifyError::Tuf(_)));
    assert_eq!(error.kind(), VerifyFailureKind::MetadataRollback);
    assert_eq!(v2.proof().trusted_state(), &state_before_failure);
}

#[tokio::test]
async fn rejects_cross_channel_root_and_feed_mix() {
    let stable = repository("stable-v1");
    let canary = repository("canary-v1");
    let previous = TrustedState::default();
    let error = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        &previous,
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&canary),
    )
    .await
    .expect_err("stable root cannot verify canary feed");
    assert!(matches!(error, VerifyError::Tuf(_)));
    assert_eq!(previous, TrustedState::default());
}

#[tokio::test]
async fn rejects_expiry_and_clock_rollback_without_advancing_state() {
    let stable = repository("stable-v1");
    let good = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable),
    )
    .await
    .expect("baseline verifies");

    let mut corrupt_proof: Value = serde_json::from_slice(
        &good
            .proof()
            .to_owner_protected_json()
            .expect("proof serializes"),
    )
    .unwrap();
    corrupt_proof["trustedState"]["snapshotJson"]
        .as_array_mut()
        .expect("snapshot bytes")
        .push(json!(b' '));
    assert!(matches!(
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&corrupt_proof).unwrap()),
        Err(VerifyError::TrustedStateIntegrityMismatch)
    ));

    let expired = repository("stable-expired-timestamp");
    let expiry_error = verify_release(
        trust(ReleaseChannel::Stable, &expired),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&expired),
    )
    .await
    .expect_err("expired timestamp fails");
    assert!(matches!(expiry_error, VerifyError::Tuf(_)));
    assert_eq!(expiry_error.kind(), VerifyFailureKind::Expired);

    let mut future_proof_json: Value = serde_json::from_slice(
        &good
            .proof()
            .to_owner_protected_json()
            .expect("proof serializes"),
    )
    .unwrap();
    future_proof_json["trustedState"]["latestKnownTimeJson"] =
        json!(br#""2099-01-01T00:00:00Z""#.to_vec());
    reseal_proof_state(&mut future_proof_json);
    let future_proof =
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&future_proof_json).unwrap())
            .expect("resealed deliberate clock fixture");
    let state_before_failure = future_proof.trusted_state().clone();
    let clock_error = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        future_proof.trusted_state(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable),
    )
    .await
    .expect_err("backward clock fails");
    assert!(matches!(clock_error, VerifyError::Tuf(_)));
    assert_eq!(clock_error.kind(), VerifyFailureKind::ClockRollback);
    assert_eq!(future_proof.trusted_state(), &state_before_failure);
}

#[tokio::test]
async fn rejects_each_invalid_root_rotation_threshold() {
    let stable = repository("stable-v1");
    for fixture in [
        "missing-old-threshold.2.root.json",
        "missing-new-threshold.2.root.json",
        "duplicate-signature.2.root.json",
        "corrupt-signature.2.root.json",
    ] {
        let replacement = fs::read(fixtures().join("adversarial").join(fixture)).unwrap();
        let transport = FixtureTransport::from_repository(&stable)
            .replace(&format!("{METADATA_BASE}2.root.json"), replacement);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &stable),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            transport,
        )
        .await
        .expect_err(fixture);
        assert!(matches!(error, VerifyError::Tuf(_)), "{fixture}: {error}");
        assert_eq!(error.kind(), VerifyFailureKind::Trust, "{fixture}");
    }
}

#[tokio::test]
async fn rejects_mix_and_match_and_corrupt_or_partial_targets() {
    let stable_v1 = repository("stable-v1");
    let stable_v2 = repository("stable-v2");
    let stale_snapshot = fs::read(stable_v1.join("metadata/1.snapshot.json")).unwrap();
    let mixed = FixtureTransport::from_repository(&stable_v2)
        .replace(&format!("{METADATA_BASE}2.snapshot.json"), stale_snapshot);
    assert!(
        verify_release(
            trust(ReleaseChannel::Stable, &stable_v2),
            &TrustedState::default(),
            &expected("0.1.5", ArtifactTarget::X86_64LinuxMusl),
            mixed,
        )
        .await
        .is_err()
    );

    for transport in [
        FixtureTransport::from_repository(&stable_v1)
            .mutate_target(ArtifactTarget::X86_64LinuxMusl.as_str(), |bytes| {
                bytes[0] ^= 0xff
            }),
        FixtureTransport::from_repository(&stable_v1).mutate_target(
            ArtifactTarget::X86_64LinuxMusl.as_str(),
            |bytes| {
                bytes.truncate(bytes.len() / 2);
            },
        ),
    ] {
        let error = verify_release(
            trust(ReleaseChannel::Stable, &stable_v1),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            transport,
        )
        .await
        .expect_err("bad target fails");
        assert!(matches!(error, VerifyError::Tuf(_)));
    }
}

#[tokio::test]
async fn rejects_wrong_destination_protocol_channel_and_build_identity() {
    let stable = repository("stable-v1");
    let transport = || FixtureTransport::from_repository(&stable);
    let wrong_destination = ExpectedTarget {
        destination: ArtifactTarget::Aarch64LinuxMusl,
        ..expected("0.1.4", ArtifactTarget::X86_64LinuxMusl)
    };
    assert!(matches!(
        verify_release(
            trust(ReleaseChannel::Stable, &stable),
            &TrustedState::default(),
            &wrong_destination,
            transport(),
        )
        .await,
        Err(VerifyError::WrongDestination { .. })
    ));

    let wrong_protocol = ExpectedTarget {
        protocol: ProtocolVersion::new(2, 0),
        ..expected("0.1.4", ArtifactTarget::X86_64LinuxMusl)
    };
    assert!(matches!(
        verify_release(
            trust(ReleaseChannel::Stable, &stable),
            &TrustedState::default(),
            &wrong_protocol,
            transport(),
        )
        .await,
        Err(VerifyError::IncompatibleProtocol { .. })
    ));

    assert!(matches!(
        verify_release(
            trust(ReleaseChannel::Canary, &stable),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            transport(),
        )
        .await,
        Err(VerifyError::RootChannelMismatch { .. })
    ));

    let wrong_build = ExpectedTarget {
        target_name: "other.x86_64-unknown-linux-musl.release.tar.gz".to_owned(),
        ..expected("0.1.4", ArtifactTarget::X86_64LinuxMusl)
    };
    assert!(matches!(
        verify_release(
            trust(ReleaseChannel::Stable, &stable),
            &TrustedState::default(),
            &wrong_build,
            transport(),
        )
        .await,
        Err(VerifyError::TargetNotFound(_))
    ));
}

#[tokio::test]
async fn enforces_signed_root_role_spec_and_expiry_policy() {
    let stable = repository("stable-v1");
    for (fixture, kind) in [
        (
            "targets-threshold-downgrade.2.root.json",
            VerifyFailureKind::Trust,
        ),
        (
            "timestamp-extra-rsa-key.2.root.json",
            VerifyFailureKind::Trust,
        ),
        (
            "unsupported-spec-version.2.root.json",
            VerifyFailureKind::Unsupported,
        ),
        ("long-expiry.2.root.json", VerifyFailureKind::Bounds),
        ("oversized.2.root.json", VerifyFailureKind::Bounds),
    ] {
        let replacement = fs::read(fixtures().join("adversarial").join(fixture)).unwrap();
        let transport = FixtureTransport::from_repository(&stable)
            .replace(&format!("{METADATA_BASE}2.root.json"), replacement);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &stable),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            transport,
        )
        .await
        .expect_err(fixture);
        assert_eq!(error.kind(), kind, "{fixture}: {error}");
    }
}

#[tokio::test]
async fn rejects_policy_downgrade_in_an_intermediate_root() {
    let stable = repository("stable-v1");
    let weakened_root =
        fs::read(fixtures().join("adversarial/targets-threshold-downgrade.2.root.json")).unwrap();
    let restored_root =
        fs::read(repository("stable-32-root-rotations").join("metadata/3.root.json")).unwrap();
    let transport = FixtureTransport::from_repository(&stable)
        .replace(&format!("{METADATA_BASE}2.root.json"), weakened_root)
        .replace(&format!("{METADATA_BASE}3.root.json"), restored_root);

    let error = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        transport,
    )
    .await
    .expect_err("a temporary role-policy downgrade must not be hidden by the final root");

    assert_eq!(error.kind(), VerifyFailureKind::Trust);
}

#[tokio::test]
async fn enforces_signed_role_lifetime_and_absolute_size_bounds() {
    for fixture in [
        "stable-long-targets",
        "stable-long-snapshot",
        "stable-long-timestamp",
        "stable-oversized-targets",
        "stable-oversized-snapshot",
        "stable-oversized-timestamp",
    ] {
        let path = repository(fixture);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &path),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            FixtureTransport::from_repository(&path),
        )
        .await
        .expect_err(fixture);
        assert_eq!(error.kind(), VerifyFailureKind::Bounds, "{fixture}");
    }
}

#[tokio::test]
async fn enforces_signed_target_count_and_length_bounds() {
    for fixture in ["stable-too-many-targets", "stable-oversized-target"] {
        let path = repository(fixture);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &path),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            FixtureTransport::from_repository(&path),
        )
        .await
        .expect_err(fixture);
        assert_eq!(error.kind(), VerifyFailureKind::Bounds, "{fixture}");
    }
}

#[tokio::test]
async fn rejects_insufficient_top_level_role_signatures() {
    for fixture in [
        "stable-insufficient-targets-signature",
        "stable-unsigned-snapshot",
        "stable-unsigned-timestamp",
    ] {
        let path = repository(fixture);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &path),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            FixtureTransport::from_repository(&path),
        )
        .await
        .expect_err(fixture);
        assert_eq!(error.kind(), VerifyFailureKind::Trust, "{fixture}");
    }
}

#[tokio::test]
async fn rejects_signed_custom_identity_mismatches() {
    for fixture in [
        "stable-custom-wrong-product",
        "stable-custom-wrong-archive",
        "stable-custom-wrong-protocol",
    ] {
        let path = repository(fixture);
        let error = verify_release(
            trust(ReleaseChannel::Stable, &path),
            &TrustedState::default(),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            FixtureTransport::from_repository(&path),
        )
        .await
        .expect_err(fixture);
        assert_eq!(error.kind(), VerifyFailureKind::Identity, "{fixture}");
    }
}

#[tokio::test]
async fn permits_exactly_32_root_rotations_and_rejects_33() {
    let allowed = repository("stable-32-root-rotations");
    let release = verify_release(
        trust(ReleaseChannel::Stable, &allowed),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&allowed),
    )
    .await
    .expect("32 sequential rotations are allowed");
    assert_eq!(release.proof().receipt().root_version, 33);
    let encoded = release
        .proof()
        .to_owner_protected_json()
        .expect("maximum refresh chain remains serializable");
    assert!(encoded.len() < hmux_release_trust::MAX_PROOF_BYTES);
    let decoded = ReleaseProof::from_owner_protected_json(&encoded)
        .expect("maximum refresh chain durably round-trips");
    decoded
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &allowed),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            release.target_path(),
        )
        .await
        .expect("maximum refresh chain revalidates");

    let rejected = repository("stable-33-root-rotations");
    let continued = verify_release(
        trust(ReleaseChannel::Stable, &rejected),
        release.proof().trusted_state(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&rejected),
    )
    .await
    .expect("a later refresh accepts the one remaining sequential rotation");
    assert_eq!(continued.proof().receipt().root_version, 34);

    let error = verify_release(
        trust(ReleaseChannel::Stable, &rejected),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&rejected),
    )
    .await
    .expect_err("33 sequential rotations exceed the local bound");
    assert_eq!(error.kind(), VerifyFailureKind::Bounds);
}

#[tokio::test]
async fn discards_changed_timestamp_with_the_same_version() {
    let stable = repository("stable-v1");
    let first = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable),
    )
    .await
    .expect("initial state verifies");
    let prior_digests = first.proof().receipt().trusted_metadata_sha256.clone();

    let changed = repository("stable-same-version-changed");
    let second = verify_release(
        trust(ReleaseChannel::Stable, &changed),
        first.proof().trusted_state(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&changed),
    )
    .await
    .unwrap_or_else(|error| {
        let mut chain = error.to_string();
        let mut source = error.source();
        while let Some(error) = source {
            chain.push_str(&format!(": {error}"));
            source = error.source();
        }
        panic!("equal-version timestamp is discarded in favor of trusted metadata: {chain}");
    });
    assert_eq!(
        second
            .proof()
            .receipt()
            .trusted_metadata_sha256
            .timestamp_json,
        prior_digests.timestamp_json
    );
    assert_eq!(
        second
            .proof()
            .receipt()
            .trusted_metadata_sha256
            .snapshot_json,
        prior_digests.snapshot_json
    );
    assert_eq!(
        second
            .proof()
            .receipt()
            .trusted_metadata_sha256
            .targets_json,
        prior_digests.targets_json
    );
}

#[tokio::test]
async fn durable_proof_revalidates_and_rejects_mix_or_target_tamper() {
    let stable_v1 = repository("stable-v1");
    let release_v1 = verify_release(
        trust(ReleaseChannel::Stable, &stable_v1),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable_v1),
    )
    .await
    .expect("v1 verifies");
    let encoded_v1 = release_v1
        .proof()
        .to_owner_protected_json()
        .expect("proof encodes");
    let decoded_v1 = ReleaseProof::from_owner_protected_json(&encoded_v1).expect("proof decodes");
    decoded_v1
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v1),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            release_v1.target_path(),
        )
        .await
        .expect("proof revalidates from exact signed bytes");

    let stable_v2 = repository("stable-v2");
    let release_v2 = verify_release(
        trust(ReleaseChannel::Stable, &stable_v2),
        release_v1.proof().trusted_state(),
        &expected("0.1.5", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable_v2),
    )
    .await
    .expect("v2 verifies");
    let mut mixed_receipt: serde_json::Value =
        serde_json::from_slice(&release_v1.proof().to_owner_protected_json().unwrap()).unwrap();
    let v2_json: serde_json::Value =
        serde_json::from_slice(&release_v2.proof().to_owner_protected_json().unwrap()).unwrap();
    mixed_receipt["trustedState"] = v2_json["trustedState"].clone();
    let mixed =
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&mixed_receipt).unwrap())
            .expect("each half is internally well formed");
    let error = mixed
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v2),
            &expected("0.1.5", ArtifactTarget::X86_64LinuxMusl),
            release_v2.target_path(),
        )
        .await
        .expect_err("receipt and state from separate generations cannot mix");
    assert_eq!(error.kind(), VerifyFailureKind::Integrity);

    let incompatible = ExpectedTarget {
        protocol: ProtocolVersion::new(2, 0),
        ..expected("0.1.4", ArtifactTarget::X86_64LinuxMusl)
    };
    let error = decoded_v1
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v1),
            &incompatible,
            release_v1.target_path(),
        )
        .await
        .expect_err("rollback proof must match the current runtime protocol");
    assert_eq!(error.kind(), VerifyFailureKind::Identity);

    let wrong_destination = ExpectedTarget {
        target_name: expected("0.1.4", ArtifactTarget::X86_64LinuxMusl).target_name,
        destination: ArtifactTarget::Aarch64LinuxMusl,
        protocol: ProtocolVersion::new(1, 0),
    };
    let error = decoded_v1
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v1),
            &wrong_destination,
            release_v1.target_path(),
        )
        .await
        .expect_err("rollback proof must match the current destination");
    assert_eq!(error.kind(), VerifyFailureKind::Identity);

    let mut changed_anchor: Value =
        serde_json::from_slice(&release_v1.proof().to_owner_protected_json().unwrap()).unwrap();
    changed_anchor["trustedState"]["bootstrapRootSha256"] = json!("0".repeat(64));
    reseal_proof_state(&mut changed_anchor);
    let changed_anchor =
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&changed_anchor).unwrap())
            .expect("changed local anchor digest is structurally valid");
    let error = changed_anchor
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v1),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            release_v1.target_path(),
        )
        .await
        .expect_err("local checkpoint remains bound to the compiled bootstrap");
    assert_eq!(error.kind(), VerifyFailureKind::Integrity);

    let mut target = fs::read(release_v1.target_path()).unwrap();
    target[0] ^= 0xff;
    fs::write(release_v1.target_path(), target).unwrap();
    let error = decoded_v1
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable_v1),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            release_v1.target_path(),
        )
        .await
        .expect_err("post-verification target mutation fails");
    assert_eq!(error.kind(), VerifyFailureKind::Integrity);
}

#[tokio::test]
async fn owner_proof_decode_and_revalidation_keep_all_product_bounds() {
    let stable = repository("stable-v1");
    let release = verify_release(
        trust(ReleaseChannel::Stable, &stable),
        &TrustedState::default(),
        &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
        FixtureTransport::from_repository(&stable),
    )
    .await
    .expect("baseline verifies");
    let mut proof_json: Value = serde_json::from_slice(
        &release
            .proof()
            .to_owner_protected_json()
            .expect("proof encodes"),
    )
    .unwrap();

    let mut unknown_field = proof_json.clone();
    unknown_field["unexpected"] = json!(true);
    assert!(matches!(
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&unknown_field).unwrap()),
        Err(VerifyError::ProofEncoding(_))
    ));

    let first_root = proof_json["trustedState"]["rootChain"][0].clone();
    proof_json["trustedState"]["rootChain"] =
        Value::Array(vec![first_root; hmux_release_trust::MAX_TRUSTED_ROOTS + 1]);
    assert!(matches!(
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&proof_json).unwrap()),
        Err(VerifyError::ProofEncoding(_))
    ));

    let mut oversized_root: Value = serde_json::from_slice(
        &release
            .proof()
            .to_owner_protected_json()
            .expect("proof encodes"),
    )
    .unwrap();
    oversized_root["trustedState"]["rootChain"][0] =
        json!(vec![0_u8; hmux_release_trust::MAX_ROOT_BYTES as usize + 1]);
    assert!(matches!(
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&oversized_root).unwrap()),
        Err(VerifyError::ProofEncoding(_))
    ));

    let mut too_many_json: Value = serde_json::from_slice(
        &release
            .proof()
            .to_owner_protected_json()
            .expect("proof encodes"),
    )
    .unwrap();
    replace_proof_metadata(&mut too_many_json, &repository("stable-too-many-targets"));
    let too_many =
        ReleaseProof::from_owner_protected_json(&serde_json::to_vec(&too_many_json).unwrap())
            .expect("signed proof generation decodes");
    let error = too_many
        .revalidate_owner_protected(
            &trust(ReleaseChannel::Stable, &stable),
            &expected("0.1.4", ArtifactTarget::X86_64LinuxMusl),
            release.target_path(),
        )
        .await
        .expect_err("proof revalidation enforces the same target-count bound");
    assert_eq!(error.kind(), VerifyFailureKind::Bounds);
}
