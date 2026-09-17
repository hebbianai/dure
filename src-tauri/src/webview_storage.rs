use std::env::{self, VarError};
use tauri::utils::config::{Config, WindowConfig};
use tauri::WebviewUrl;

const DEV_WEBVIEW_DATA_STORE_ENV: &str = "DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER";

fn parse_identifier(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{DEV_WEBVIEW_DATA_STORE_ENV} must be exactly 32 lowercase hexadecimal characters"
        ));
    }

    let mut identifier = [0_u8; 16];
    for (index, slot) in identifier.iter_mut().enumerate() {
        let offset = index * 2;
        *slot = u8::from_str_radix(&value[offset..offset + 2], 16).map_err(|_| {
            format!("{DEV_WEBVIEW_DATA_STORE_ENV} contains invalid hexadecimal data")
        })?;
    }
    Ok(identifier)
}

pub fn apply_dev(context: &mut tauri::Context<tauri::Wry>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let value = match env::var(DEV_WEBVIEW_DATA_STORE_ENV) {
        Ok(value) => value,
        Err(VarError::NotPresent) => return Ok(()),
        Err(VarError::NotUnicode(_)) => {
            return Err(format!("{DEV_WEBVIEW_DATA_STORE_ENV} must be valid UTF-8"));
        }
    };
    let identifier = parse_identifier(&value)?;
    let windows = &mut context.config_mut().app.windows;
    if windows.is_empty() {
        return Err("dev WebView isolation requires an initial window".to_string());
    }
    for window in windows {
        window.data_store_identifier = Some(identifier);
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebviewStorageOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    data_store_identifier: Option<[u8; 16]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_directory: Option<std::path::PathBuf>,
}

fn configured_options(config: &Config) -> Result<WebviewStorageOptions, String> {
    let initial = config.app.windows.first().ok_or("initial window config is missing")?;
    Ok(WebviewStorageOptions {
        data_store_identifier: initial.data_store_identifier,
        data_directory: initial.data_directory.clone(),
    })
}

/// Secondary windows inherit storage, not the initial window's geometry or URL.
pub(crate) fn window_config(
    config: &Config,
    label: &str,
    url: WebviewUrl,
) -> Result<WindowConfig, String> {
    let storage = configured_options(config)?;
    Ok(WindowConfig {
        label: label.to_string(),
        url,
        data_store_identifier: storage.data_store_identifier,
        data_directory: storage.data_directory,
        ..Default::default()
    })
}

#[tauri::command]
pub(crate) fn webview_storage_options(app: tauri::AppHandle) -> Result<WebviewStorageOptions, String> {
    configured_options(app.config())
}

#[cfg(test)]
mod tests {
    use super::{configured_options, parse_identifier, window_config};
    use tauri::utils::config::{Config, WindowConfig};
    use tauri::WebviewUrl;

    #[test]
    fn additional_windows_inherit_only_the_selected_storage() {
        let mut config = Config::default();
        config.app.windows = vec![WindowConfig {
            label: "source".into(),
            url: WebviewUrl::App("source.html".into()),
            width: 999.0,
            create: false,
            data_store_identifier: Some([17; 16]),
            data_directory: Some("configured-directory".into()),
            ..Default::default()
        }];
        let options = serde_json::to_value(configured_options(&config).unwrap()).unwrap();
        assert_eq!(options, serde_json::json!({
            "dataStoreIdentifier": vec![17; 16],
            "dataDirectory": "configured-directory",
        }));
        for label in ["qa-window", "design-mode-browser"] {
            let url = WebviewUrl::App("secondary.html".into());
            let secondary = window_config(&config, label, url.clone()).unwrap();
            assert_eq!(secondary.label, label);
            assert_eq!(secondary.url, url);
            assert_eq!(secondary.data_store_identifier, Some([17; 16]));
            assert_eq!(secondary.data_directory, config.app.windows[0].data_directory);
            assert_eq!(secondary.width, WindowConfig::default().width);
            assert!(secondary.create);
        }
    }

    #[test]
    fn unconfigured_storage_remains_default_but_missing_config_is_not_invented() {
        let mut config = Config::default();
        config.app.windows = vec![WindowConfig::default()];
        assert_eq!(
            serde_json::to_value(configured_options(&config).unwrap()).unwrap(),
            serde_json::json!({})
        );
        let secondary = window_config(&config, "secondary", WebviewUrl::default()).unwrap();
        assert_eq!(secondary.data_store_identifier, None);
        assert_eq!(secondary.data_directory, None);
        config.app.windows.clear();
        assert!(configured_options(&config).is_err());
        assert!(window_config(&config, "secondary", WebviewUrl::default()).is_err());
    }

    #[test]
    fn exact_identifier_parses_to_sixteen_bytes() {
        assert_eq!(
            parse_identifier("000102030405060708090a0b0c0d0e0f").unwrap(),
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
        );
    }

    #[test]
    fn malformed_or_unbounded_identifiers_fail_closed() {
        for value in [
            "",
            "00",
            "000102030405060708090a0b0c0d0e0",
            "000102030405060708090a0b0c0d0e0f00",
            "000102030405060708090a0b0c0d0e0g",
            "000102030405060708090A0B0C0D0E0F",
        ] {
            assert!(parse_identifier(value).is_err(), "accepted {value:?}");
        }
    }
}
