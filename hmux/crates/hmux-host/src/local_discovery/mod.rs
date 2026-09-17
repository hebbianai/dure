#[cfg(feature = "ghostty-core-proof")]
mod cold_history_storage;
mod discovery_error;
mod discovery_key;
mod discovery_state_gc;
mod file_lock;
mod manifest_store;
#[cfg(feature = "local-runtime")]
mod presentation_checkpoint;
#[doc(hidden)]
pub mod private_storage;
mod registration_capacity;
mod session_lookup;
mod workspace_identity;

#[cfg(feature = "ghostty-core-proof")]
pub(crate) use cold_history_storage::ColdHistoryStorage;
pub use discovery_error::{DiscoveryError, SecurityViolation, StaleDiscoveryReason};
pub use discovery_key::{
    DiscoveryKey, DiscoveryKeyError, MAX_DISCOVERY_ID_BYTES, SessionLookupKey,
};
pub use discovery_state_gc::{
    DiscoveryGcDiagnostic, DiscoveryGcHygiene, DiscoveryGcMode, DiscoveryGcPlan, DiscoveryGcPolicy,
    DiscoveryGcProcessStatus, DiscoveryGcReport, DiscoveryGcSelection, DiscoveryGcSweep,
    DiscoveryMaintenanceLock,
};
pub use hmux_session_protocol::discovery::{
    ClaimLinkage, DiscoveryManifest, ExitedManifest, HostLifetimeIdentity,
    LAUNCH_PROGRAM_MAX_BYTES, LocalEndpoint, LocalEndpointKind, ManifestCommon, ManifestGeneration,
    ManifestLimits, ManifestValidationError, ReadyManifest, SessionClass, SessionRetirementPolicy,
    StartingManifest, launch_program_label,
};
pub use manifest_store::{DiscoveryRoot, LifetimeLock, SessionDiscovery};
#[cfg(feature = "local-runtime")]
pub use manifest_store::{PresentationCheckpointWriteError, PresentationCheckpointWritePhase};
#[cfg(feature = "local-runtime")]
pub use presentation_checkpoint::{
    PRESENTATION_CHECKPOINT_MAX_BYTES, PresentationCheckpoint, PresentationCheckpointHandoff,
    PresentationCheckpointSource,
};
pub use registration_capacity::DiscoveryRegistrationCapacity;
pub use session_lookup::{DiscoveredSession, ExitedSessionCensus};
pub use workspace_identity::workspace_id_for_path;
