// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Device values adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447
// cli/src/native/actions.rs (v0.27.0).
// Dure changes: typed ingress, page-owned dispatch, profile UA policy and reset.
// The upstream license is retained in device/LICENSE-agent-browser.

use dure_app::BrowserProfileUserAgentModeV1;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug)]
pub(super) struct BrowserDevice {
    width: u32,
    height: u32,
    scale: f64,
    user_agent: &'static str,
}

impl<'de> Deserialize<'de> for BrowserDevice {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl TryFrom<String> for BrowserDevice {
    type Error = &'static str;
    fn try_from(name: String) -> Result<Self, Self::Error> {
        if name.len() > 128 {
            return Err("browser_device_unknown");
        }
        let (width, height, scale, user_agent) = match name.to_ascii_lowercase().as_str() {
            "iphone 15" | "iphone15" => (
                393,
                852,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            ),
            "iphone 16" | "iphone16" => (
                393,
                852,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            ),
            "iphone 16 pro" | "iphone16pro" => (
                402,
                874,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            ),
            "iphone 17" | "iphone17" => (
                402,
                874,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
            ),
            "ipad" | "ipad air" => (
                820,
                1180,
                2.0,
                "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1",
            ),
            "ipad pro" => (
                1024,
                1366,
                2.0,
                "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1",
            ),
            "pixel 9" | "pixel9" => (
                412,
                923,
                2.625,
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
            ),
            "galaxy s25" | "galaxys25" => (
                360,
                800,
                3.0,
                "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
            ),
            "iphone 12" | "iphone12" => (
                390,
                844,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
            ),
            "iphone 14" | "iphone14" => (
                390,
                844,
                3.0,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
            ),
            "pixel 5" | "pixel5" => (
                393,
                851,
                2.75,
                "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
            ),
            "pixel 7" | "pixel7" => (
                412,
                915,
                2.625,
                "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
            ),
            "galaxy s21" | "galaxys21" => (
                360,
                800,
                3.0,
                "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
            ),
            _ => return Err("browser_device_unknown"),
        };
        Ok(Self {
            width,
            height,
            scale,
            user_agent,
        })
    }
}

impl BrowserDevice {
    pub(super) fn commands(
        &self,
        user_agent_mode: BrowserProfileUserAgentModeV1,
    ) -> Vec<(&'static str, Value)> {
        // Emulate CSS metrics without also replacing the native view's size.
        // Chromium's screenshot path sizes its surface for the emulated DPR;
        // the native window remains the authority when metrics are cleared.
        let mut commands = vec![(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": self.width, "height": self.height,
                "deviceScaleFactor": self.scale, "mobile": true,
                "dontSetVisibleSize": true,
            }),
        )];
        // A native profile changes device dimensions while keeping the
        // browser's own renderer identity and generated request headers.
        if user_agent_mode == BrowserProfileUserAgentModeV1::Clean {
            commands.push((
                "Emulation.setUserAgentOverride",
                json!({"userAgent":self.user_agent}),
            ));
        }
        commands
    }
}
