use super::*;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use ProviderRuntimeIntegrationRequirement as Requirement;

const CHANNEL: &str = "dev-integration-fixture";

fn write_owner_file(path: &Path, contents: &[u8], mode: u32) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .unwrap();
    std::io::Write::write_all(&mut file, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn owner_directory(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

/// A channel directory with a published Codex notify script and Claude
/// settings file, and the document that lists the given providers.
fn publish(control_dir: &Path, channel: &str, providers: &[&str]) -> PathBuf {
    owner_directory(control_dir);
    let notify = control_dir.join("managed-codex-notify.sh");
    let settings = control_dir.join("managed-claude-settings.json");
    write_owner_file(&notify, b"#!/bin/sh\nexit 0\n", 0o700);
    write_owner_file(&settings, b"{}\n", 0o600);
    let integrations = providers
        .iter()
        .map(|provider| {
            let integration = match *provider {
                "codex" => ProviderRuntimeIntegrationV1::NotificationCommand {
                    command: vec![notify.to_string_lossy().into_owned()],
                },
                _ => ProviderRuntimeIntegrationV1::SettingsFile {
                    path: settings.to_string_lossy().into_owned(),
                },
            };
            (ProviderIdV1::new(*provider).unwrap(), integration)
        })
        .collect();
    let document = ProviderRuntimeIntegrationsV1 {
        schema_version: dure_app::PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
        channel: channel.into(),
        integrations,
    };
    let path = control_dir.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1);
    write_owner_file(&path, &serde_json::to_vec(&document).unwrap(), 0o600);
    path
}

fn claude() -> ProviderIdV1 {
    ProviderIdV1::new("claude").unwrap()
}

/// Every refusal keeps the one code older clients know, and names its
/// requirement and the document relative to the Dure home.
fn assert_refused(
    source: &ChannelProviderRuntimeIntegrationSource,
    requirement: Requirement,
    document: &str,
) {
    assert_eq!(
        source.integration(&claude()).unwrap_err().as_str(),
        PROVIDER_RUNTIME_INTEGRATION_UNAVAILABLE
    );
    assert_eq!(
        source.refusal(&claude()),
        Some(ProviderRuntimeIntegrationRefusal {
            requirement,
            document: document.into(),
        })
    );
}

#[test]
fn a_refused_integration_names_the_unmet_requirement() {
    let fixture = tempfile::tempdir().unwrap();
    let channel_document = format!("channels/{CHANNEL}/{PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1}");
    let control_dir = fixture.path().join("channels").join(CHANNEL);
    let source = ChannelProviderRuntimeIntegrationSource::at(CHANNEL, control_dir.clone());

    // No app ever ran for this channel: neither directory nor document exists.
    assert_refused(&source, Requirement::DocumentMissing, &channel_document);
    owner_directory(&control_dir);
    assert_refused(&source, Requirement::DocumentMissing, &channel_document);

    let document = publish(&control_dir, CHANNEL, &["codex", "claude"]);
    assert!(source.inspect(&claude()).is_ok());
    assert_eq!(source.refusal(&claude()), None);

    fs::set_permissions(&control_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert_refused(&source, Requirement::Directory, &channel_document);
    fs::set_permissions(&control_dir, fs::Permissions::from_mode(0o700)).unwrap();

    fs::set_permissions(&document, fs::Permissions::from_mode(0o644)).unwrap();
    assert_refused(&source, Requirement::DocumentUnsafe, &channel_document);

    write_owner_file(&document, b"{\"schemaVersion\":", 0o600);
    assert_refused(&source, Requirement::DocumentInvalid, &channel_document);

    publish(&control_dir, "another-channel", &["codex", "claude"]);
    assert_refused(&source, Requirement::DocumentChannel, &channel_document);

    // The app published Codex but not Claude.
    publish(&control_dir, CHANNEL, &["codex"]);
    assert!(source.inspect(&ProviderIdV1::new("codex").unwrap()).is_ok());
    assert_refused(&source, Requirement::Provider, &channel_document);

    publish(&control_dir, CHANNEL, &["codex", "claude"]);
    fs::remove_file(control_dir.join("managed-claude-settings.json")).unwrap();
    assert_refused(&source, Requirement::Reference, &channel_document);
}

#[test]
fn the_stable_channel_document_sits_at_the_dure_home() {
    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path().join("home");
    let source = ChannelProviderRuntimeIntegrationSource::at(STABLE_CHANNEL, home);
    assert_refused(
        &source,
        Requirement::DocumentMissing,
        PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1,
    );
}

#[test]
fn doctor_status_reports_the_same_check_per_provider() {
    let fixture = tempfile::tempdir().unwrap();
    let control_dir = fixture.path().join("channels").join(CHANNEL);
    let source = ChannelProviderRuntimeIntegrationSource::at(CHANNEL, control_dir.clone());
    let providers = ["claude".to_string(), "codex".to_string()];

    let missing = integration_status(&source, &providers);
    assert_eq!(missing["schemaVersion"], 1);
    assert_eq!(missing["kind"], "dure.provider_runtime_integration_status");
    assert_eq!(missing["channel"], CHANNEL);
    assert_eq!(
        missing["document"],
        control_dir
            .join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1)
            .to_str()
            .unwrap()
    );
    assert_eq!(
        missing["providers"],
        serde_json::json!([
            { "providerId": "claude", "status": "unavailable", "requirement": "integration_document_missing" },
            { "providerId": "codex", "status": "unavailable", "requirement": "integration_document_missing" },
        ])
    );

    publish(&control_dir, CHANNEL, &["codex"]);
    assert_eq!(
        integration_status(&source, &providers)["providers"],
        serde_json::json!([
            { "providerId": "claude", "status": "unavailable", "requirement": "integration_provider_unpublished" },
            { "providerId": "codex", "status": "current", "requirement": null },
        ])
    );
}
