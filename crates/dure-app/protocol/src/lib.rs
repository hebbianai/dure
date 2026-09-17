//! Dependency-light wire contracts shared by Dure application adapters.

// A JSON integer is also a Rust integer expression; the installed CLI reads
// the same bound without a second constant or a runtime Rust dependency.
pub const MAX_BACKEND_CAPABILITIES_V1: usize =
    include!("../../../../cli/lib/backend-capability-limit.json");

mod domain_id;
mod git_checkout;

pub use domain_id::{DomainIdErrorV1, OperationIdV1, validate_domain_id};
pub use git_checkout::{
    GIT_CHECKOUT_SCHEMA_VERSION_V1, GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
    GitCheckoutCaptureRequestV1, GitCheckoutCreationReservationV1, GitCheckoutInstanceV1,
    GitCheckoutLocationV1, GitCheckoutPathObservationV1, GitCheckoutReferenceV1,
    GitCheckoutRegistrationV1,
    GitCheckoutRemovalOutcomeV1, GitCheckoutRemovalPermitV1, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalReceiptV1, GitCheckoutRemovalRequestV1, GitCheckoutUseActionV1,
    GitCheckoutUseClaimV1, GitCheckoutUseOutcomeV1, GitCheckoutUsePhaseV1,
    GitCheckoutUsePhysicalRemovalRequestV1, GitCheckoutUseReceiptV1, GitCheckoutUseRequestV1,
    GitCheckoutUseRevisionV1, MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1,
    MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1, MAX_GIT_CHECKOUT_USE_REVISION_V1,
};
