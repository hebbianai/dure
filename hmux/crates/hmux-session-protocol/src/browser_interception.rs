//! Bounded page request rules. Matching and normalization have one authority.

use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BrowserUrlPattern {
    source: String,
    tokens: Vec<Token>,
}

#[derive(Clone, Debug)]
enum Token {
    Literal(char),
    Any,
    Star,
}

impl TryFrom<String> for BrowserUrlPattern {
    type Error = &'static str;
    fn try_from(source: String) -> Result<Self, Self::Error> {
        if source.is_empty() || source.len() > 512 || source.chars().any(char::is_control) {
            return Err("browser_route_pattern_invalid");
        }
        let mut tokens = Vec::new();
        let mut chars = source.chars();
        while let Some(ch) = chars.next() {
            tokens.push(match ch {
                '*' if matches!(tokens.last(), Some(Token::Star)) => continue,
                '*' => Token::Star,
                '?' => Token::Any,
                '\\' => Token::Literal(chars.next().ok_or("browser_route_pattern_invalid")?),
                literal => Token::Literal(literal),
            });
        }
        Ok(Self { source, tokens })
    }
}

impl From<BrowserUrlPattern> for String {
    fn from(value: BrowserUrlPattern) -> Self {
        value.source
    }
}

impl BrowserUrlPattern {
    pub fn as_str(&self) -> &str {
        &self.source
    }

    /// Full URL match: * spans any characters, ? one character, backslash escapes.
    pub fn matches(&self, url: &str) -> bool {
        let mut token = 0;
        let mut offset = 0;
        let mut star = None;
        let mut retry = 0;
        while let Some(ch) = url[offset..].chars().next() {
            match self.tokens.get(token) {
                Some(Token::Literal(literal)) if *literal == ch => {
                    token += 1;
                    offset += ch.len_utf8();
                }
                Some(Token::Any) => {
                    token += 1;
                    offset += ch.len_utf8();
                }
                Some(Token::Star) => {
                    token += 1;
                    star = Some(token);
                    retry = offset;
                }
                _ => {
                    let Some(next_token) = star else {
                        return false;
                    };
                    let Some(next) = url[retry..].chars().next() else {
                        return false;
                    };
                    retry += next.len_utf8();
                    offset = retry;
                    token = next_token;
                }
            }
        }
        self.tokens[token..]
            .iter()
            .all(|token| matches!(token, Token::Star))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "RawRule")]
pub struct BrowserRequestRule {
    patterns: Vec<BrowserUrlPattern>,
    resource_types: Vec<String>,
    effect: BrowserRequestEffect,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserRequestEffect {
    Continue,
    Abort,
    Respond {
        body: String,
        status: u16,
        headers: BTreeMap<String, String>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    patterns: Vec<BrowserUrlPattern>,
    #[serde(default)]
    resource_types: Vec<String>,
    effect: BrowserRequestEffect,
}

impl TryFrom<RawRule> for BrowserRequestRule {
    type Error = &'static str;
    fn try_from(raw: RawRule) -> Result<Self, Self::Error> {
        if raw.patterns.is_empty() || raw.patterns.len() > 32 || raw.resource_types.len() > 16 {
            return Err("browser_route_limit");
        }
        let mut resource_types = Vec::new();
        for value in raw.resource_types {
            let value = value.to_ascii_lowercase();
            if ["websocket", "preflight"].contains(&value.as_str()) {
                return Err("browser_route_resource_type_unsupported");
            }
            if ![
                "document",
                "stylesheet",
                "image",
                "media",
                "font",
                "script",
                "texttrack",
                "xhr",
                "fetch",
                "prefetch",
                "eventsource",
                "manifest",
                "signedexchange",
                "ping",
                "cspviolationreport",
                "other",
            ]
            .contains(&value.as_str())
            {
                return Err("browser_route_resource_type_invalid");
            }
            if !resource_types.contains(&value) {
                resource_types.push(value);
            }
        }
        if let BrowserRequestEffect::Respond {
            body,
            status,
            headers,
        } = &raw.effect
        {
            if body.len() > 256 * 1024
                || !(200..=599).contains(status)
                || ([204, 205, 304].contains(status) && !body.is_empty())
            {
                return Err("browser_route_response_invalid");
            }
            let mut names = std::collections::BTreeSet::new();
            if headers.len() > 64
                || headers
                    .iter()
                    .map(|(key, value)| key.len() + value.len())
                    .sum::<usize>()
                    > 16 * 1024
                || headers.iter().any(|(name, value)| {
                    name.is_empty()
                        || !name.bytes().all(|ch| {
                            ch.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&ch)
                        })
                        || value
                            .bytes()
                            .any(|ch| (ch < 32 && ch != b'\t') || ch == 127)
                        || !names.insert(name.to_ascii_lowercase())
                        || ["content-length", "transfer-encoding", "connection"]
                            .contains(&name.to_ascii_lowercase().as_str())
                })
            {
                return Err("browser_route_headers_invalid");
            }
        }
        Ok(Self {
            patterns: raw.patterns,
            resource_types,
            effect: raw.effect,
        })
    }
}

impl BrowserRequestRule {
    pub fn patterns(&self) -> &[BrowserUrlPattern] {
        &self.patterns
    }
    pub fn effect(&self) -> &BrowserRequestEffect {
        &self.effect
    }

    /// Remove declarations by exact spelling, without matching the pattern as a URL.
    /// An empty rule is discarded instead of exposing an invalid rule value.
    pub fn excluding_pattern(mut self, pattern: &BrowserUrlPattern) -> Option<Self> {
        self.patterns
            .retain(|existing| existing.as_str() != pattern.as_str());
        (!self.patterns.is_empty()).then_some(self)
    }

    pub fn matches_url(&self, url: &str) -> bool {
        self.patterns.iter().any(|pattern| pattern.matches(url))
    }
    pub fn matches_resource_type(&self, resource_type: Option<&str>) -> Option<bool> {
        if self.resource_types.is_empty() {
            return Some(true);
        }
        resource_type.map(|kind| {
            self.resource_types
                .iter()
                .any(|value| value.eq_ignore_ascii_case(kind))
        })
    }
    pub fn matches(&self, url: &str, resource_type: &str) -> bool {
        self.matches_url(url) && self.matches_resource_type(Some(resource_type)) == Some(true)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserInterceptionAction {
    Enable { rule: BrowserRequestRule },
    Remove { pattern: BrowserUrlPattern },
    Disable,
}

#[derive(Debug, Serialize)]
pub struct BrowserInterceptionStatus {
    pub page: BrowserPageIdentity,
    pub enabled: bool,
    pub available: bool,
    pub rules: Vec<BrowserRequestRule>,
    pub requests: Vec<crate::browser_network::BrowserNetworkRequest>,
    pub history_truncated: bool,
}

#[cfg(test)]
mod tests;
