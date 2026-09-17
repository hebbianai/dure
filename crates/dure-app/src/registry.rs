use std::{
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    CompatibilityOutcomeV1, ExtensionAvailabilityV1, ExtensionDescriptorV1, ExtensionFailureCodeV1,
    ExtensionIdV1, HostCompatibilityV1, UnavailableReasonV1, evaluate_compatibility,
};

#[derive(Clone, Copy, Debug)]
pub struct ExtensionProbeContextV1 {
    started_at: Instant,
    timeout: Duration,
}

impl ExtensionProbeContextV1 {
    pub fn new(timeout: Duration) -> Self {
        Self {
            started_at: Instant::now(),
            timeout,
        }
    }

    pub fn is_expired(self) -> bool {
        self.started_at.elapsed() >= self.timeout
    }

    pub fn timeout(self) -> Duration {
        self.timeout
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionProbeOutcomeV1 {
    Available,
    Unavailable {
        code: ExtensionFailureCodeV1,
        retryable: bool,
    },
    TimedOut,
}

/// Minimal behavior boundary shared by all extension families.
///
/// Family-specific operations intentionally do not live here. The descriptor
/// selects a small family contract, and future family traits can evolve behind
/// that DTO without adding optional methods to this base trait.
pub trait ExtensionImplementation: Send + Sync {
    fn descriptor(&self) -> &ExtensionDescriptorV1;

    fn probe(&self, context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistrationOutcomeV1 {
    Registered(CompatibilityOutcomeV1),
    Rejected(CompatibilityOutcomeV1),
    InvalidDescriptor { message: String },
    DuplicateId { id: ExtensionIdV1 },
}

#[derive(Default)]
pub struct ExtensionRegistry {
    extensions: BTreeMap<ExtensionIdV1, Arc<dyn ExtensionImplementation>>,
}

impl ExtensionRegistry {
    pub fn len(&self) -> usize {
        self.extensions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.extensions.is_empty()
    }

    pub fn get(&self, id: &ExtensionIdV1) -> Option<&Arc<dyn ExtensionImplementation>> {
        self.extensions.get(id)
    }

    pub fn register(
        &mut self,
        implementation: Arc<dyn ExtensionImplementation>,
        host: &HostCompatibilityV1,
        probe_timeout: Duration,
    ) -> RegistrationOutcomeV1 {
        let descriptor = implementation.descriptor();
        if let Err(error) = descriptor.validate() {
            return RegistrationOutcomeV1::InvalidDescriptor {
                message: error.to_string(),
            };
        }
        if self.extensions.contains_key(&descriptor.id) {
            return RegistrationOutcomeV1::DuplicateId {
                id: descriptor.id.clone(),
            };
        }

        // Negotiate only against data before executing extension-owned code.
        // An incompatible extension must not get a chance to probe, resume, or
        // otherwise reinterpret failure as a fresh operation.
        let compatibility =
            evaluate_compatibility(descriptor, host, ExtensionAvailabilityV1::Available);
        if !compatibility.is_supported() {
            return RegistrationOutcomeV1::Rejected(compatibility);
        }

        let context = ExtensionProbeContextV1::new(probe_timeout);
        let probe = catch_unwind(AssertUnwindSafe(|| implementation.probe(context)));
        let availability = match probe {
            Ok(ExtensionProbeOutcomeV1::Available) if context.is_expired() => {
                ExtensionAvailabilityV1::Unavailable {
                    reason: UnavailableReasonV1::ProbeTimedOut,
                    retryable: true,
                }
            }
            Ok(ExtensionProbeOutcomeV1::Available) => ExtensionAvailabilityV1::Available,
            Ok(ExtensionProbeOutcomeV1::Unavailable { code, retryable }) => {
                ExtensionAvailabilityV1::Unavailable {
                    reason: UnavailableReasonV1::ProbeFailed { code },
                    retryable,
                }
            }
            Ok(ExtensionProbeOutcomeV1::TimedOut) => ExtensionAvailabilityV1::Unavailable {
                reason: UnavailableReasonV1::ProbeTimedOut,
                retryable: true,
            },
            Err(_) => ExtensionAvailabilityV1::Unavailable {
                reason: UnavailableReasonV1::ProbeFailed {
                    code: ExtensionFailureCodeV1::new("probe_panicked")
                        .expect("static failure code is valid"),
                },
                retryable: false,
            },
        };
        let availability_outcome = evaluate_compatibility(descriptor, host, availability);
        if !availability_outcome.is_supported() {
            return RegistrationOutcomeV1::Rejected(availability_outcome);
        }

        self.extensions
            .insert(descriptor.id.clone(), implementation);
        RegistrationOutcomeV1::Registered(compatibility)
    }
}
