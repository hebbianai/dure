use serde::Serialize;

pub(crate) const INDEPENDENT_INSTALLER_SOURCE: &str = "independent_installer";
pub(crate) const LOCAL_BUNDLED_SOURCE: &str = "local_bundled";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeInstallSource {
    IndependentInstaller,
    BundledFallback,
    Unverified,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IndependentInstallReadiness {
    Ready,
    BundledFallback,
    ProvenanceUnknown,
    CliUnavailable,
    ProtocolIncompatible,
    CapabilityUnavailable,
    InstallUnsafe,
    ProbeFailed,
    MetadataInconsistent,
    Unavailable,
}

pub(crate) fn with_probe_failure(
    health: IndependentInstallHealth,
    probe_failure_stage: &'static str,
) -> IndependentInstallHealth {
    IndependentInstallHealth {
        readiness: IndependentInstallReadiness::ProbeFailed,
        diagnostic_code: "hmux_independent_install_probe_failed",
        probe_failure_stage: Some(probe_failure_stage),
        ..health
    }
}

pub(crate) fn with_missing_capability(
    health: IndependentInstallHealth,
) -> IndependentInstallHealth {
    IndependentInstallHealth {
        readiness: IndependentInstallReadiness::CapabilityUnavailable,
        diagnostic_code: "hmux_independent_install_pairing_capability_unavailable",
        probe_failure_stage: None,
        ..health
    }
}

pub(crate) fn with_unsafe_install(
    health: IndependentInstallHealth,
) -> IndependentInstallHealth {
    IndependentInstallHealth {
        readiness: IndependentInstallReadiness::InstallUnsafe,
        diagnostic_code: "hmux_independent_install_permissions_unsafe",
        probe_failure_stage: None,
        ..health
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndependentInstallHealth {
    pub source: RuntimeInstallSource,
    pub readiness: IndependentInstallReadiness,
    pub diagnostic_code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe_failure_stage: Option<&'static str>,
    pub cli_available: bool,
    pub protocol_compatible: bool,
}

impl IndependentInstallHealth {
    pub(crate) fn unavailable() -> Self {
        Self {
            source: RuntimeInstallSource::Unavailable,
            readiness: IndependentInstallReadiness::Unavailable,
            diagnostic_code: "hmux_independent_install_unavailable",
            probe_failure_stage: None,
            cli_available: false,
            protocol_compatible: false,
        }
    }

    pub(crate) fn diagnostic_message(self) -> String {
        match self.probe_failure_stage {
            Some(stage) => format!("{}; stage={stage}", self.diagnostic_code),
            None => self.diagnostic_code.to_string(),
        }
    }
}

pub(crate) fn assess_independent_install(
    activation_source: Option<&str>,
    declared_cli_available: Option<bool>,
    cli_available: bool,
    protocol_compatible: bool,
) -> IndependentInstallHealth {
    let source = match activation_source {
        Some(INDEPENDENT_INSTALLER_SOURCE) => RuntimeInstallSource::IndependentInstaller,
        None if cli_available => RuntimeInstallSource::IndependentInstaller,
        Some(LOCAL_BUNDLED_SOURCE) => RuntimeInstallSource::BundledFallback,
        Some(_) | None => RuntimeInstallSource::Unverified,
    };
    if declared_cli_available.is_some_and(|declared| declared != cli_available) {
        return IndependentInstallHealth {
            source,
            readiness: IndependentInstallReadiness::MetadataInconsistent,
            diagnostic_code: "hmux_independent_install_metadata_inconsistent",
            probe_failure_stage: None,
            cli_available,
            protocol_compatible,
        };
    }
    match source {
        RuntimeInstallSource::IndependentInstaller if !protocol_compatible => {
            IndependentInstallHealth {
                source,
                readiness: IndependentInstallReadiness::ProtocolIncompatible,
                diagnostic_code: "hmux_independent_install_protocol_incompatible",
                probe_failure_stage: None,
                cli_available,
                protocol_compatible,
            }
        }
        RuntimeInstallSource::IndependentInstaller if !cli_available => IndependentInstallHealth {
            source,
            readiness: IndependentInstallReadiness::CliUnavailable,
            diagnostic_code: "hmux_independent_install_cli_unavailable",
            probe_failure_stage: None,
            cli_available,
            protocol_compatible,
        },
        RuntimeInstallSource::IndependentInstaller => IndependentInstallHealth {
            source,
            readiness: IndependentInstallReadiness::Ready,
            diagnostic_code: "hmux_independent_install_ready",
            probe_failure_stage: None,
            cli_available,
            protocol_compatible,
        },
        RuntimeInstallSource::BundledFallback => IndependentInstallHealth {
            source,
            readiness: IndependentInstallReadiness::BundledFallback,
            diagnostic_code: "hmux_independent_install_bundled_fallback",
            probe_failure_stage: None,
            cli_available,
            protocol_compatible,
        },
        RuntimeInstallSource::Unverified => IndependentInstallHealth {
            source,
            readiness: IndependentInstallReadiness::ProvenanceUnknown,
            diagnostic_code: "hmux_independent_install_provenance_unknown",
            probe_failure_stage: None,
            cli_available,
            protocol_compatible,
        },
        RuntimeInstallSource::Unavailable => IndependentInstallHealth::unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_independent_install_is_ready() {
        let ready = assess_independent_install(
            Some(INDEPENDENT_INSTALLER_SOURCE),
            Some(true),
            true,
            true,
        );
        assert_eq!(ready.readiness, IndependentInstallReadiness::Ready);
        assert_eq!(ready.diagnostic_code, "hmux_independent_install_ready");

        let no_cli = assess_independent_install(
            Some(INDEPENDENT_INSTALLER_SOURCE),
            Some(false),
            false,
            true,
        );
        assert_eq!(
            no_cli.readiness,
            IndependentInstallReadiness::CliUnavailable
        );

        let incompatible = assess_independent_install(
            Some(INDEPENDENT_INSTALLER_SOURCE),
            Some(true),
            true,
            false,
        );
        assert_eq!(
            incompatible.readiness,
            IndependentInstallReadiness::ProtocolIncompatible
        );
    }

    #[test]
    fn bundled_unknown_and_inconsistent_metadata_fail_closed() {
        let bundled = assess_independent_install(
            Some(LOCAL_BUNDLED_SOURCE),
            Some(false),
            false,
            true,
        );
        assert_eq!(
            bundled.readiness,
            IndependentInstallReadiness::BundledFallback
        );

        let legacy = assess_independent_install(None, None, true, true);
        assert_eq!(legacy.readiness, IndependentInstallReadiness::Ready);

        let unknown = assess_independent_install(Some("unknown_source"), None, true, true);
        assert_eq!(
            unknown.readiness,
            IndependentInstallReadiness::ProvenanceUnknown
        );

        let inconsistent = assess_independent_install(
            Some(INDEPENDENT_INSTALLER_SOURCE),
            Some(false),
            true,
            true,
        );
        assert_eq!(
            inconsistent.readiness,
            IndependentInstallReadiness::MetadataInconsistent
        );
    }
}
