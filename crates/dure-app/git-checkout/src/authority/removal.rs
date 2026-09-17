use super::*;
use crate::GitCheckoutRemovalRequestV1;

/// One caller-owned removal operation, recovered from the existing Git-ref authority.
pub struct GitCheckoutRemovalOperation {
    authority: Authority,
    instance: GitCheckoutInstanceV1,
    instance_digest: String,
    policy: GitCheckoutRemovalPolicyV1,
    namespace: &'static str,
    namespace_digest: String,
    retiring_registration: Option<OperationIdV1>,
}

enum RemovalAdmission {
    Permitted(Box<GitCheckoutRemovalPermitV1>),
    Removed(GitCheckoutRemovalReceiptV1),
}

/// A durable permit must exist before a caller stops any checkout user.
pub struct AdmittedGitCheckoutRemoval {
    operation: GitCheckoutRemovalOperation,
    admission: RemovalAdmission,
}

pub(super) fn owns_permit_operation(namespace: &str, digest: &str, operation_id: &str) -> bool {
    let prefix = format!("{namespace}-permit-r");
    let suffix = format!("-{digest}");
    let Some(revision) = operation_id
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(&suffix))
    else {
        return false;
    };
    let Ok(value) = revision.parse::<u64>() else {
        return false;
    };
    value <= MAX_GIT_CHECKOUT_USE_REVISION_V1 && value.to_string() == revision
}

impl GitCheckoutRemovalOperation {
    pub fn new(
        request: &GitCheckoutRemovalRequestV1,
        operation_id: &OperationIdV1,
    ) -> Result<Self, GitCheckoutInstanceError> {
        Self::from_parts(
            Path::new(&request.repository_path),
            &request.instance,
            request.policy,
            Some(operation_id),
        )
        .map_err(use_error_as_instance)
    }

    /// Retire this caller's registration only; every other active use still blocks removal.
    pub fn retiring_registration(mut self, registration_id: &OperationIdV1) -> Self {
        self.retiring_registration = Some(registration_id.clone());
        self
    }

    fn from_parts(
        repository: &Path,
        instance: &GitCheckoutInstanceV1,
        policy: GitCheckoutRemovalPolicyV1,
        operation_id: Option<&OperationIdV1>,
    ) -> Result<Self, GitCheckoutUseError> {
        let repository = TrustedLocator::parse_path(repository, "repository path")?;
        let validated = ValidatedGitCheckoutInstance::parse(instance)
            .map_err(|cause| instance_error(cause, InstanceErrorContext::Request))?;
        let (authority, instance_digest) =
            Authority::for_validated_instance(&repository, &validated)?;
        let (namespace, namespace_digest) = match operation_id {
            Some(operation_id) => (
                "removal",
                digest_fields(
                    &authority.repository,
                    b"dure-checkout-removal-operation-v1",
                    &[operation_id.as_str(), &instance_digest],
                )?,
            ),
            None => ("legacy", instance_digest.clone()),
        };
        Ok(Self {
            authority,
            instance: validated.into_instance(),
            instance_digest,
            policy,
            namespace,
            namespace_digest,
            retiring_registration: None,
        })
    }

    fn operation_id(
        &self,
        action: &str,
        revision: u64,
    ) -> Result<OperationIdV1, GitCheckoutUseError> {
        OperationIdV1::new(format!(
            "{}-{action}-r{revision}-{}",
            self.namespace, self.namespace_digest,
        ))
        .map_err(|_| state_error("derived checkout removal operation id is invalid"))
    }

    fn persisted_permit(
        &self,
        state: &State,
        namespace: &str,
        namespace_digest: &str,
    ) -> Result<Option<GitCheckoutRemovalPermitV1>, GitCheckoutUseError> {
        if state.phase() != Phase::Removing
            || state.instance_digest() != Some(&self.instance_digest)
        {
            return Ok(None);
        }
        let permit = permit_from_state(&self.authority, state, &self.instance)?;
        if permit
            .retiring_claims
            .iter()
            .any(|claim| self.retiring_registration.as_ref() != Some(&claim.claim_id))
            || !owns_permit_operation(namespace, namespace_digest, permit.operation_id.as_str())
        {
            return Ok(None);
        }
        let digest = permit_request_digest(
            &self.authority,
            &permit.operation_id,
            &self.instance_digest,
            &permit
                .retiring_claims
                .iter()
                .map(|claim| claim.claim_id.clone())
                .collect::<Vec<_>>(),
            self.policy,
        )?;
        Ok((digest == permit.request_digest).then_some(permit))
    }

    fn apply(
        &self,
        operation_id: OperationIdV1,
        action: GitCheckoutUseActionV1,
    ) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
        apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: self.authority.repository.to_string_lossy().into_owned(),
            operation_id,
            action,
        })
    }

    fn admission(&self) -> Result<RemovalAdmission, GitCheckoutUseError> {
        let loaded = read_state(&self.authority)?;
        if let Some(loaded) = &loaded {
            if loaded.state.phase() == Phase::Removed
                && loaded.state.instance_digest() == Some(&self.instance_digest)
            {
                application::reconcile_directory_removal(
                    &mut DirectoryUseGuard::open()?,
                    &self.authority,
                    &self.instance,
                )?;
                return Ok(RemovalAdmission::Removed(GitCheckoutRemovalReceiptV1 {
                    schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                    outcome: GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
                    instance: self.instance.clone(),
                }));
            }
            if let Some(permit) =
                self.persisted_permit(&loaded.state, self.namespace, &self.namespace_digest)?
            {
                DirectoryUseGuard::open()?.begin_removal(&self.instance)?;
                return Ok(RemovalAdmission::Permitted(Box::new(permit)));
            }
        }
        // Only an authoritative abort releases a previous permit. A retry after
        // that release uses the observed revision; an in-flight permit replays above.
        let revision = loaded.as_ref().map_or(0, |loaded| loaded.state.revision);
        let retiring_claim_ids = self
            .retiring_registration
            .iter()
            .filter(|id| {
                loaded.as_ref().is_some_and(|loaded| {
                    loaded.state.instance_digest() == Some(&self.instance_digest)
                        && loaded
                            .state
                            .claims
                            .get(id.as_str())
                            .is_some_and(Claim::is_active)
                })
            })
            .cloned()
            .collect();
        let receipt = self.apply(
            self.operation_id("permit", revision)?,
            GitCheckoutUseActionV1::AcquireRemovalPermit {
                instance: self.instance.clone(),
                retiring_claim_ids,
                policy: self.policy,
            },
        )?;
        match receipt.outcome {
            GitCheckoutUseOutcomeV1::RemovalPermitted { permit } => {
                Ok(RemovalAdmission::Permitted(Box::new(permit)))
            }
            GitCheckoutUseOutcomeV1::Removed { removal, .. } => {
                Ok(RemovalAdmission::Removed(removal))
            }
            _ => Err(phase_conflict("removal did not acquire one removal permit")),
        }
    }

    pub fn admit(self) -> Result<AdmittedGitCheckoutRemoval, GitCheckoutInstanceError> {
        let admission = self.admission().map_err(use_error_as_instance)?;
        Ok(AdmittedGitCheckoutRemoval {
            operation: self,
            admission,
        })
    }

    /// Resume a legacy removal after the caller's pre-removal effects committed.
    /// New requests use `admit` and cannot borrow a legacy permit before those effects.
    pub fn resume(mut self) -> Result<AdmittedGitCheckoutRemoval, GitCheckoutInstanceError> {
        if let Some(loaded) = read_state(&self.authority).map_err(use_error_as_instance)? {
            if let Some(permit) = self
                .persisted_permit(&loaded.state, "legacy", &self.instance_digest)
                .map_err(use_error_as_instance)?
            {
                DirectoryUseGuard::open()
                    .and_then(|mut guard| guard.begin_removal(&self.instance))
                    .map_err(use_error_as_instance)?;
                self.namespace = "legacy";
                self.namespace_digest = self.instance_digest.clone();
                return Ok(AdmittedGitCheckoutRemoval {
                    operation: self,
                    admission: RemovalAdmission::Permitted(Box::new(permit)),
                });
            }
        }
        self.admit()
    }

    /// Release only this operation's live permit, including after response loss.
    /// An absent, aborted, removed, or successor-owned permit needs no mutation.
    pub fn abort(self) -> Result<(), GitCheckoutInstanceError> {
        self.abort_using_authority().map_err(use_error_as_instance)
    }

    fn abort_using_authority(&self) -> Result<(), GitCheckoutUseError> {
        let Some(loaded) = read_state(&self.authority)? else {
            return application::reconcile_directory_removal(
                &mut DirectoryUseGuard::open()?,
                &self.authority,
                &self.instance,
            );
        };
        let Some(permit) =
            self.persisted_permit(&loaded.state, self.namespace, &self.namespace_digest)?
        else {
            return application::reconcile_directory_removal(
                &mut DirectoryUseGuard::open()?,
                &self.authority,
                &self.instance,
            );
        };
        self.apply(
            self.operation_id("abort", permit.revision.value())?,
            GitCheckoutUseActionV1::AbortRemoval {
                instance: self.instance.clone(),
                permit_token: permit.permit_token,
            },
        )?;
        Ok(())
    }
}

impl AdmittedGitCheckoutRemoval {
    pub fn abort(self) -> Result<(), GitCheckoutInstanceError> {
        self.operation.abort()
    }

    pub fn remove(self) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
        self.remove_using(remove_git_checkout_instance_at_classified)
    }

    fn remove_using(
        self,
        physical_remove: impl FnOnce(
            &Path,
            &ValidatedGitCheckoutInstance,
            GitCheckoutRemovalPolicyV1,
        ) -> Result<
            GitCheckoutRemovalReceiptV1,
            GitCheckoutPhysicalRemovalError,
        >,
    ) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
        let permit = match self.admission {
            RemovalAdmission::Removed(receipt) => return Ok(receipt),
            RemovalAdmission::Permitted(permit) => permit,
        };
        let operation = self.operation;
        let receipt = remove_git_checkout_with_permit_using(
            &GitCheckoutUsePhysicalRemovalRequestV1 {
                schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
                repository_path: operation
                    .authority
                    .repository
                    .to_string_lossy()
                    .into_owned(),
                operation_id: operation
                    .operation_id("physical", permit.revision.value())
                    .map_err(use_error_as_instance)?,
                instance: operation.instance,
                permit_token: permit.permit_token,
                policy: operation.policy,
            },
            physical_remove,
        )
        .map_err(use_error_as_instance)?;
        match receipt.outcome {
            GitCheckoutUseOutcomeV1::Removed { removal, .. } => Ok(removal),
            _ => Err(GitCheckoutInstanceError::new(
                "checkout_use_state_invalid",
                "composed checkout removal did not terminalize",
            )),
        }
    }
}

pub(crate) fn remove_git_checkout_instance_admitted(
    repository: &Path,
    instance: &GitCheckoutInstanceV1,
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    remove_git_checkout_instance_admitted_using(
        repository,
        instance,
        policy,
        remove_git_checkout_instance_at_classified,
    )
}

pub(super) fn remove_git_checkout_instance_admitted_using(
    repository: &Path,
    instance: &GitCheckoutInstanceV1,
    policy: GitCheckoutRemovalPolicyV1,
    physical_remove: impl FnOnce(
        &Path,
        &ValidatedGitCheckoutInstance,
        GitCheckoutRemovalPolicyV1,
    )
        -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutPhysicalRemovalError>,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    GitCheckoutRemovalOperation::from_parts(repository, instance, policy, None)
        .map_err(use_error_as_instance)?
        .admit()?
        .remove_using(physical_remove)
}

#[cfg(test)]
pub(super) fn legacy_operation_id(
    prefix: &str,
    state_revision: u64,
    instance_digest: &str,
) -> Result<OperationIdV1, GitCheckoutUseError> {
    OperationIdV1::new(format!(
        "legacy-{prefix}-r{state_revision}-{instance_digest}"
    ))
    .map_err(|_| state_error("derived legacy checkout-use operation id is invalid"))
}
