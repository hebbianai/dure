//! Profile replacement keeps logical page identity under the admitted action.
use super::*;
use dure_app::{BrowserProfileIdV1, BrowserProfileSpecV1};
use hmux_host::browser_resource::creation::BrowserPageCreationPermit;

mod cloning;
mod creation;

pub(crate) enum BrowserProfileAction {
    Set,
    Clone,
    Create {
        url: BrowserPageUrl,
        label: Option<BrowserPageLabel>,
    },
}

enum Destination {
    Unchanged,
    Existing {
        source: BrowserProfileSource,
        creation: Box<BrowserPageCreationPermit>,
    },
    Starting(lifecycle::BrowserInitialization),
}

/// Service admission retains the destination before releasing profile selection.
/// Waiting for native construction and navigation does not hold that service lock.
pub(crate) struct BrowserProfileChange<'a> {
    execution: Execution<'a>,
    completion: completion::ActionCompletion,
    page: BrowserPageIdentity,
    action: BrowserProfileAction,
    profile: BrowserProfileSpecV1,
    destination: Result<Destination, BrowserRuntimeError>,
}

impl BrowserProfileChange<'_> {
    pub(crate) async fn finish(self) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let Self {
            execution,
            mut completion,
            page,
            action,
            profile,
            destination,
        } = self;
        let dispatched = match destination {
            Ok(Destination::Unchanged) => execution
                .resource
                .host
                .lock()
                .await
                .dispatch_target(completion.permit())
                .map(|_| profile_response(&page, profile.profile_id()))
                .map_err(Into::into),
            Ok(destination) => match action {
                BrowserProfileAction::Set => {
                    execution
                        .replace_profile(completion.permit_mut(), profile.profile_id(), destination)
                        .await
                }
                BrowserProfileAction::Clone | BrowserProfileAction::Create { .. } => {
                    let url = match action {
                        BrowserProfileAction::Create { url, .. } => Some(url),
                        _ => None,
                    };
                    execution
                        .create_profile_page(
                            completion.permit(),
                            &page,
                            profile.profile_id(),
                            destination,
                            url.as_ref().map(BrowserPageUrl::as_str),
                        )
                        .await
                }
            },
            Err(error) => Err(error),
        };
        execution
            .complete_action(completion, dispatched, true)
            .await
    }
}

impl BrowserRuntime {
    pub async fn set_profile(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        config: &NativeBrowserEngineConfig,
        profile: &BrowserProfileSpecV1,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let source = self.profile_source(profile.profile_id()).await;
        self.admit_profile_change(
            caller,
            authority,
            config,
            BrowserProfileAction::Set,
            profile,
            source,
        )
        .await?
        .finish()
        .await
    }

    pub(crate) async fn admit_profile_change(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserActionAuthority,
        config: &NativeBrowserEngineConfig,
        action: BrowserProfileAction,
        profile: &BrowserProfileSpecV1,
        source: Option<BrowserProfileSource>,
    ) -> Result<BrowserProfileChange<'_>, BrowserRuntimeError> {
        let (execution, permit) = {
            let mut host = self.host.lock().await;
            let permit = host.begin_action(caller, authority, None)?;
            if let BrowserProfileAction::Create {
                label: Some(label), ..
            } = &action
            {
                if let Err(error) = host.reserve_creation_label(&permit, label.clone()) {
                    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)?;
                    return Err(error.into());
                }
            }
            let instance = host.instance_for_page(&authority.page.page_id)?.clone();
            let execution = match self.execution_for_instance(&instance) {
                Ok(execution) => execution,
                Err(error) => {
                    host.finish_action(permit, BrowserActionOutcome::RejectedBeforeDispatch)?;
                    return Err(error);
                }
            };
            (execution, permit)
        };
        let completion = completion::ActionCompletion::new(&execution, permit);
        let destination = async {
            if let Some(local) = self.profile_source(profile.profile_id()).await {
                if matches!(action, BrowserProfileAction::Set)
                    && local.instance() == execution.binding.events.instance()
                {
                    return Ok(Destination::Unchanged);
                }
                let creation = {
                    let mut host = self.host.lock().await;
                    match action {
                        BrowserProfileAction::Set => {
                            host.prepare_page_replacement(completion.permit(), local.instance())?
                        }
                        BrowserProfileAction::Clone | BrowserProfileAction::Create { .. } => {
                            host.prepare_page_creation_in(completion.permit(), local.instance())?
                        }
                    }
                };
                return Ok(Destination::Existing {
                    source: local,
                    creation: Box::new(creation),
                });
            }
            if matches!(
                action,
                BrowserProfileAction::Clone | BrowserProfileAction::Create { .. }
            ) {
                return Ok(Destination::Starting(
                    self.admit_clone_binding(config, profile, source, completion.permit())
                        .await?,
                ));
            }
            let admitted = match source {
                Some(source) => {
                    self.admit_shared_replacement_binding(source, completion.permit())
                        .await?
                }
                None => {
                    self.admit_replacement_binding(config, profile, completion.permit())
                        .await?
                }
            };
            Ok(Destination::Starting(admitted))
        }
        .await;
        Ok(BrowserProfileChange {
            execution,
            completion,
            page: authority.page.clone(),
            action,
            profile: profile.clone(),
            destination,
        })
    }
}

impl Execution<'_> {
    async fn replace_profile(
        &self,
        permit: &mut BrowserActionPermit,
        profile: &BrowserProfileIdV1,
        destination: Destination,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let url = self.profile_source_url(permit).await?;
        let (instance, creation) = destination.ready().await?;
        let replaced: Result<_, BrowserRuntimeError> = async {
            let next = self.resource.execution_for_instance(&instance)?;
            let (page, retired) = {
                let mut engine = next.engine().await?;
                let target = next
                    .profile_created_target(&mut engine, permit, creation)
                    .await?;
                let published = self
                    .resource
                    .host
                    .lock()
                    .await
                    .replace_page_binding(permit, &target)?;
                self.resource.changed.notify_waiters();
                let observed = next.observe_engine(&mut engine).await?;
                let navigation = next
                    .navigate_page(permit, observed.cdp, &target, &url)
                    .await?;
                if !navigation.success {
                    return Err("browser_profile_navigation_failed".into());
                }
                next.observe_engine(&mut engine).await?;
                published
            };
            // Host still owns this retiring target if the caller or reply is
            // lost. Resource close uses the same instance's retained target set.
            let mut cdp = self.binding.cdp.clone();
            lifecycle::close_targets(&mut cdp, std::slice::from_ref(retired.target())).await?;
            self.binding.events.synchronize_events().await?;
            self.resource
                .host
                .lock()
                .await
                .replaced_target_retired(&retired)?;
            let empty = self
                .resource
                .host
                .lock()
                .await
                .instance_targets(retired.instance())
                .is_empty();
            if empty {
                self.resource.retire_binding(retired.instance()).await?;
            }
            let page = self
                .resource
                .host
                .lock()
                .await
                .page_identity(&page.page_id)?;
            Ok(profile_response(&page, profile))
        }
        .await;
        replaced
            .map_err(|_| BrowserEngineError::after("browser_profile_replacement_incomplete").into())
    }
}

fn profile_response(
    page: &BrowserPageIdentity,
    profile: &BrowserProfileIdV1,
) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-profile".into(),
        success: true,
        data: json!({"page":page,"profile_id":profile}),
        error: None,
    }
}
