use super::ReadEventsRequest;
use crate::domain::{AuthorityScope, ValidationError};

/// A validated event query with no acknowledgement or delivery transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InspectEventsRequest(ReadEventsRequest);

impl TryFrom<ReadEventsRequest> for InspectEventsRequest {
    type Error = ValidationError;

    fn try_from(request: ReadEventsRequest) -> Result<Self, Self::Error> {
        if request.acknowledgement.is_some() {
            return Err(ValidationError {
                field: "acknowledgement",
                code: "inspection_cannot_acknowledge",
            });
        }
        request.validate()?;
        Ok(Self(request))
    }
}

impl InspectEventsRequest {
    pub fn authority(&self) -> &AuthorityScope {
        &self.0.authority
    }

    pub(crate) fn as_read_request(&self) -> &ReadEventsRequest {
        &self.0
    }
}
