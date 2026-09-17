use super::super::observation;
use super::{BrowserElementTarget, BrowserRuntimeError, Execution, WaitTimeout};
use hmux_session_protocol::browser_resource::{BrowserPageIdentity, BrowserTargetId};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ElementState {
    Visible,
    Hidden,
    Attached,
    Detached,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum LoadState {
    Load,
    DomContentLoaded,
    NetworkIdle,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Condition {
    Selector {
        target: BrowserElementTarget,
        state: ElementState,
    },
    Text {
        text: String,
    },
    Url {
        pattern: UrlPattern,
    },
    Load {
        state: LoadState,
    },
    Duration,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWait {
    condition: Condition,
    timeout_ms: WaitTimeout,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "RawWait")]
pub struct BrowserWait {
    pub(super) condition: Condition,
    pub(super) timeout_ms: WaitTimeout,
}

impl TryFrom<RawWait> for BrowserWait {
    type Error = &'static str;
    fn try_from(wait: RawWait) -> Result<Self, Self::Error> {
        match &wait.condition {
            Condition::Selector { target, .. } if target.reference().is_some() => {
                return Err("browser_wait_requires_selector");
            }
            Condition::Text { text } if text.is_empty() || text.len() > 64 * 1024 => {
                return Err("browser_wait_text_invalid");
            }
            _ => {}
        }
        Ok(Self {
            condition: wait.condition,
            timeout_ms: wait.timeout_ms,
        })
    }
}

impl Condition {
    pub(super) async fn ready(
        &self,
        runtime: &Execution<'_>,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
        mut cdp: super::super::BrowserCdp,
    ) -> Result<bool, BrowserRuntimeError> {
        let expression = match self {
            Self::Selector { target, state } => {
                let selector = target.selector()?;
                let node = match selector.strip_prefix("xpath=") {
                    Some(xpath) => format!(
                        "document.evaluate({},document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue",
                        json!(xpath)
                    ),
                    None => format!("document.querySelector({})", json!(selector)),
                };
                // Preserve the native wait states, including opacity in hidden
                // and geometry in visible, without invoking page-world getters.
                let predicate = match state {
                    ElementState::Attached => "!!node",
                    ElementState::Detached => "!node",
                    ElementState::Hidden => {
                        "!node||(()=>{const style=getComputedStyle(node);return style.display==='none'||style.visibility==='hidden'||style.opacity==='0';})()"
                    }
                    ElementState::Visible => {
                        "!!node&&(()=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';})()"
                    }
                };
                format!("(()=>{{const node={node};return {predicate};}})()")
            }
            Self::Text { text } => {
                format!("(document.body?.innerText??'').includes({})", json!(text))
            }
            Self::Url { pattern } => {
                return Ok(pattern.matches(&observation::url(&mut cdp, target.as_str()).await?));
            }
            Self::Load {
                state: LoadState::DomContentLoaded,
            } => "document.readyState!=='loading'".into(),
            Self::Load {
                state: LoadState::Load,
            } => "document.readyState==='complete'".into(),
            Self::Load {
                state: LoadState::NetworkIdle,
            } => {
                let network = runtime.network_snapshot(page).await?;
                if !network.complete {
                    return Err("browser_network_observation_incomplete".into());
                }
                return Ok(network.idle);
            }
            Self::Duration => return Err("browser_wait_condition_invalid".into()),
        };
        observation::document(&mut cdp, target.as_str(), &expression)
            .await?
            .as_bool()
            .ok_or_else(|| "browser_wait_observation_invalid".into())
    }
}

/// Native URL waits use literal substrings or ordered `*`-separated literals.
/// Normalize once; user input never becomes JavaScript or a regular expression.
#[derive(Debug, Deserialize)]
#[serde(try_from = "String")]
pub(super) enum UrlPattern {
    Substring(String),
    Wildcard {
        parts: Vec<String>,
        start: bool,
        end: bool,
    },
}

impl TryFrom<String> for UrlPattern {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.len() > 8192 {
            return Err("browser_wait_url_invalid");
        }
        if !value.contains('*') {
            return Ok(Self::Substring(value));
        }
        Ok(Self::Wildcard {
            parts: value
                .split('*')
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect(),
            start: !value.starts_with('*'),
            end: !value.ends_with('*'),
        })
    }
}

impl UrlPattern {
    fn matches(&self, url: &str) -> bool {
        let Self::Wildcard { parts, start, end } = self else {
            let Self::Substring(text) = self else {
                unreachable!()
            };
            return url.contains(text);
        };
        let mut remaining = url;
        for (index, part) in parts.iter().enumerate() {
            if index + 1 == parts.len() && *end {
                return remaining
                    .strip_suffix(part)
                    .is_some_and(|prefix| index != 0 || !start || prefix.is_empty());
            }
            remaining = if index == 0 && *start {
                match remaining.strip_prefix(part) {
                    Some(tail) => tail,
                    None => return false,
                }
            } else {
                match remaining.find(part) {
                    Some(offset) => &remaining[offset + part.len()..],
                    None => return false,
                }
            };
        }
        true
    }
}
