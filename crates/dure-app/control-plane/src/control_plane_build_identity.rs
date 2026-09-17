use std::collections::BTreeSet;
use std::sync::LazyLock;

use dure_app::MAX_BACKEND_CAPABILITIES_V1;
use serde::Deserialize;

const SOURCE: &str = include_str!("../../../../cli/lib/control-plane-build-identity.json");
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildIdentityManifest {
    schema_version: u16,
    current_build_id: String,
    previous_build_id: String,
    identity: IdentityManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityManifest {
    api_version: String,
    kind: String,
    capabilities: Vec<String>,
}

static BUILD_IDENTITY: LazyLock<BuildIdentityManifest> = LazyLock::new(|| {
    parse(SOURCE).unwrap_or_else(|error| panic!("invalid control-plane build identity: {error}"))
});

fn safe_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'/' | b'-')
        })
}

fn build_sequence(value: &str) -> Option<u64> {
    let versioned = value.strip_prefix("dure-control-plane/v")?;
    let (sequence, suffix) = versioned.split_once('-')?;
    if !safe_token(value)
        || sequence.starts_with('0')
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
        || suffix.is_empty()
        || !suffix.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
    {
        return None;
    }
    sequence
        .parse()
        .ok()
        .filter(|sequence| *sequence <= MAX_SAFE_SEQUENCE)
}

fn parse(source: &str) -> Result<BuildIdentityManifest, String> {
    let manifest: BuildIdentityManifest =
        serde_json::from_str(source).map_err(|error| error.to_string())?;
    let capabilities = &manifest.identity.capabilities;
    let Some(current_sequence) = build_sequence(&manifest.current_build_id) else {
        return Err("current build id is invalid".into());
    };
    let Some(previous_sequence) = build_sequence(&manifest.previous_build_id) else {
        return Err("previous build id is invalid".into());
    };
    if manifest.schema_version != 1
        || previous_sequence >= current_sequence
        || !safe_token(&manifest.identity.api_version)
        || !safe_token(&manifest.identity.kind)
        || capabilities.is_empty()
        || capabilities.len() > MAX_BACKEND_CAPABILITIES_V1
        || capabilities
            .iter()
            .any(|capability| !safe_token(capability))
        || capabilities.iter().collect::<BTreeSet<_>>().len() != capabilities.len()
    {
        return Err("manifest fields are invalid".into());
    }
    Ok(manifest)
}

pub(super) fn current_build_id() -> &'static str {
    &BUILD_IDENTITY.current_build_id
}

pub(super) fn identity_api_version() -> &'static str {
    &BUILD_IDENTITY.identity.api_version
}

pub(super) fn identity_kind() -> &'static str {
    &BUILD_IDENTITY.identity.kind
}

pub(super) fn capabilities() -> &'static [String] {
    &BUILD_IDENTITY.identity.capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_manifest_is_strict_and_complete() {
        let manifest = parse(SOURCE).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_ne!(manifest.current_build_id, manifest.previous_build_id);
        assert!(!manifest.identity.capabilities.is_empty());
    }

    #[test]
    fn dispatch_stop_lifecycle_is_advertised_as_one_backend_contract() {
        for operation in [
            "dispatch.stop.preview",
            "dispatch.stop.apply",
            "dispatch.stop.status",
        ] {
            assert!(
                capabilities()
                    .iter()
                    .any(|capability| capability == operation),
                "control-plane build identity does not advertise {operation}",
            );
        }
    }
}
