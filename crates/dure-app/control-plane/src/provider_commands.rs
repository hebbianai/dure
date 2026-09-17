use super::*;

pub(super) async fn dispatch(
    state: &ServiceState,
    request: &BackendRequest,
) -> Result<Value, BackendDispatchError> {
    match request.operation.as_str() {
        "provider_launch_defaults.get" => {
            if request.body
                != json!({
                    "schemaVersion": PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                })
            {
                return Err("provider_launch_defaults_request_invalid".into());
            }
            let document = state
                .store
                .provider_launch_defaults()
                .await
                .map_err(provider_launch_defaults_error)?;
            Ok(json!({ "schemaVersion": 1, "document": document }))
        }
        "provider_launch_defaults.put" => {
            let body: ProviderLaunchDefaultsPutRequestV1 =
                serde_json::from_value(request.body.clone())
                    .map_err(|_| "provider_launch_defaults_request_invalid".to_string())?;
            let updated_at_ms = now_ms().map_err(|_| {
                BackendDispatchError::from("provider_launch_defaults_clock_unavailable")
            })?;
            let receipt = state
                .store
                .put_provider_launch_defaults(&body, updated_at_ms)
                .await
                .map_err(provider_launch_defaults_error)?;
            Ok(json!({ "schemaVersion": 1, "receipt": receipt }))
        }
        "provider_credential_profile.register" => {
            let body: provider_credential_profile::RegisterProviderCredentialProfileBodyV1 =
                serde_json::from_value(request.body.clone()).map_err(|_| {
                    BackendDispatchError::from("provider_credential_profile_request_invalid")
                })?;
            let profile = state
                .credential_profiles
                .register(body)
                .await
                .map_err(provider_credential_profile_error)?;
            Ok(json!({ "schemaVersion": 1, "profile": profile }))
        }
        "provider_catalog.read" => provider_model_catalog::read(request.body.clone()).await,
        _ => Err("provider_operation_unsupported".into()),
    }
}
