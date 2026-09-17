//! Bounded SSH transport; the remote helper owns product lifetime decisions.

use dure_session_runtime::host_command::{
    decode_helper_response, CheckoutHostCommandV1, CheckoutHostContextV1, CheckoutHostRequestV1,
    HelperCallErrorV1, HelperErrorV1,
};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[cfg(not(windows))]
use crate::remote_hmux_install::RemoteHmuxRuntimeLocation;
use crate::{remote_path::RemotePosixPath, ssh};

pub(crate) struct RemoteCheckoutHost {
    session: ssh::PooledSession,
    helper: String,
    context: CheckoutHostContextV1,
}

impl RemoteCheckoutHost {
    #[cfg(not(windows))]
    pub(crate) fn prepare<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        options: ssh::SshOptions,
        runtime: Option<&RemoteHmuxRuntimeLocation>,
    ) -> Result<Self, String> {
        let Some(runtime) = runtime else {
            return Self::prepare_registration(app, options);
        };
        Self::on(
            app,
            ssh::acquire(&options)?,
            runtime.home().clone(),
            Some(runtime.executable().clone()),
        )
    }

    fn on<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        session: ssh::PooledSession,
        home: RemotePosixPath,
        runtime: Option<RemotePosixPath>,
    ) -> Result<Self, String> {
        let helper = crate::remote_git_checkout_helper::ensure_on(app, &session)?;
        Ok(Self {
            session,
            helper,
            context: CheckoutHostContextV1 {
                application_home: None,
                user_home: home.as_str().into(),
                runtime_executable: runtime.map(|path| path.as_str().into()),
                discovery_root: None,
            },
        })
    }

    pub(crate) fn prepare_registration<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        options: ssh::SshOptions,
    ) -> Result<Self, String> {
        let session = ssh::acquire(&options)?;
        let (home, runtime) = ssh::host_location::observed_host_location(&session)?;
        Self::on(app, session, home, runtime)
    }

    pub(crate) fn execute<T: DeserializeOwned>(
        &self,
        command: CheckoutHostCommandV1,
        timeout: Duration,
    ) -> Result<T, HelperCallErrorV1> {
        let request = serde_json::to_string(&CheckoutHostRequestV1 {
            context: self.context.clone(),
            command,
        })
        .map_err(|error| {
            HelperCallErrorV1::Reported(HelperErrorV1 {
                code: "remote_session_checkout_request_invalid".into(),
                message: error.to_string(),
            })
        })?;
        let result = ssh::exec_on_with_stdin_timeout(
            &self.session,
            &format!("{} session-v1", ssh::shell_quote(&self.helper)),
            Some(&request),
            timeout,
        )
        .map_err(HelperCallErrorV1::OutcomeUnknown)?;
        decode_helper_response(result.code, result.stdout.as_bytes())
    }
}

#[cfg(all(test, not(windows)))]
mod tests;
