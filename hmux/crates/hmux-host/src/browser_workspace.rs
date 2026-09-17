//! One fenced selection owner per workspace, separate from page/input authority.
use hmux_session_protocol::browser_resource::{
    BrowserResourceGeneration, BrowserResourceIdentity, BrowserWorkspaceId,
};
use hmux_session_protocol::browser_workspace::BrowserWorkspaceTarget;
use std::num::NonZeroU64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserWorkspaceTargetError {
    IdentityMismatch,
    SelectionChanged,
    RevisionExhausted,
}

pub struct BrowserWorkspaceTargetHost {
    target: BrowserWorkspaceTarget,
}

impl BrowserWorkspaceTargetHost {
    pub fn new(workspace_id: BrowserWorkspaceId, generation: BrowserResourceGeneration) -> Self {
        Self {
            target: BrowserWorkspaceTarget {
                workspace_id,
                generation,
                revision: NonZeroU64::MIN,
                current_resource: None,
            },
        }
    }

    pub fn projection(&self) -> BrowserWorkspaceTarget {
        self.target.clone()
    }

    pub fn created(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<BrowserWorkspaceTarget, BrowserWorkspaceTargetError> {
        self.validate(resource)?;
        self.replace(Some(resource.clone()))
    }

    pub fn select(
        &mut self,
        expected: &BrowserWorkspaceTarget,
        resource: &BrowserResourceIdentity,
    ) -> Result<BrowserWorkspaceTarget, BrowserWorkspaceTargetError> {
        self.validate(resource)?;
        if *expected != self.target {
            return Err(BrowserWorkspaceTargetError::SelectionChanged);
        }
        self.replace(Some(resource.clone()))
    }

    pub fn retired(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<BrowserWorkspaceTarget, BrowserWorkspaceTargetError> {
        self.validate(resource)?;
        if self.target.current_resource.as_ref() != Some(resource) {
            return Ok(self.projection());
        }
        self.replace(None)
    }

    fn validate(
        &self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserWorkspaceTargetError> {
        if resource.workspace_id != self.target.workspace_id
            || resource.generation != self.target.generation
        {
            return Err(BrowserWorkspaceTargetError::IdentityMismatch);
        }
        Ok(())
    }

    fn replace(
        &mut self,
        resource: Option<BrowserResourceIdentity>,
    ) -> Result<BrowserWorkspaceTarget, BrowserWorkspaceTargetError> {
        if resource == self.target.current_resource {
            return Ok(self.projection());
        }
        let revision = self
            .target
            .revision
            .checked_add(1)
            .ok_or(BrowserWorkspaceTargetError::RevisionExhausted)?;
        self.target.current_resource = resource;
        self.target.revision = revision;
        Ok(self.projection())
    }
}

#[cfg(test)]
mod tests;
