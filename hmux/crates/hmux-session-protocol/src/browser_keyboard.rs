//! Normalized DOM keys and keyboard contact identity, independent of an engine.

use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct BrowserKey {
    name: String,
    code: String,
    location: u8,
    modifier: u8,
}

impl TryFrom<String> for BrowserKey {
    type Error = &'static str;
    fn try_from(raw: String) -> Result<Self, Self::Error> {
        if raw.is_empty() || raw.len() > 128 || raw.chars().any(char::is_control) {
            return Err("browser_key_invalid");
        }
        if let Some(letter) = raw
            .strip_prefix("Key")
            .filter(|value| value.len() == 1 && value.as_bytes()[0].is_ascii_uppercase())
        {
            return Self::try_from(letter.to_ascii_lowercase());
        }
        if let Some(digit) = raw
            .strip_prefix("Digit")
            .filter(|value| value.len() == 1 && value.as_bytes()[0].is_ascii_digit())
        {
            return Self::try_from(digit.to_owned());
        }
        let lower = raw.to_ascii_lowercase();
        let named = match lower.as_str() {
            "alt" | "altleft" => Some(("Alt", "AltLeft", 1, 1)),
            "altright" => Some(("Alt", "AltRight", 2, 1)),
            "control" | "ctrl" | "controlleft" => Some(("Control", "ControlLeft", 1, 2)),
            "controlright" => Some(("Control", "ControlRight", 2, 2)),
            "meta" | "cmd" | "command" | "metaleft" => Some(("Meta", "MetaLeft", 1, 4)),
            "metaright" => Some(("Meta", "MetaRight", 2, 4)),
            "shift" | "shiftleft" => Some(("Shift", "ShiftLeft", 1, 8)),
            "shiftright" => Some(("Shift", "ShiftRight", 2, 8)),
            "enter" | "return" => Some(("Enter", "Enter", 0, 0)),
            "numpadenter" => Some(("Enter", "NumpadEnter", 3, 0)),
            "tab" => Some(("Tab", "Tab", 0, 0)),
            "escape" | "esc" => Some(("Escape", "Escape", 0, 0)),
            "space" | " " => Some((" ", "Space", 0, 0)),
            "backspace" => Some(("Backspace", "Backspace", 0, 0)),
            "delete" | "del" => Some(("Delete", "Delete", 0, 0)),
            "insert" => Some(("Insert", "Insert", 0, 0)),
            "arrowup" | "up" => Some(("ArrowUp", "ArrowUp", 0, 0)),
            "arrowdown" | "down" => Some(("ArrowDown", "ArrowDown", 0, 0)),
            "arrowleft" | "left" => Some(("ArrowLeft", "ArrowLeft", 0, 0)),
            "arrowright" | "right" => Some(("ArrowRight", "ArrowRight", 0, 0)),
            "home" => Some(("Home", "Home", 0, 0)),
            "end" => Some(("End", "End", 0, 0)),
            "pageup" => Some(("PageUp", "PageUp", 0, 0)),
            "pagedown" => Some(("PageDown", "PageDown", 0, 0)),
            _ => None,
        };
        if let Some((name, code, location, modifier)) = named {
            return Ok(Self {
                name: name.into(),
                code: code.into(),
                location,
                modifier,
            });
        }
        let mut chars = raw.chars();
        let first = chars.next().unwrap();
        let code = if chars.next().is_none() {
            if first.is_ascii_alphabetic() {
                format!("Key{}", first.to_ascii_uppercase())
            } else if first.is_ascii_digit() {
                format!("Digit{first}")
            } else {
                let pairs = [
                    ("`~", "Backquote"),
                    ("-_", "Minus"),
                    ("=+", "Equal"),
                    ("[{", "BracketLeft"),
                    ("]}", "BracketRight"),
                    ("\\|", "Backslash"),
                    (";:", "Semicolon"),
                    ("'\"", "Quote"),
                    (",<", "Comma"),
                    (".>", "Period"),
                    ("/?", "Slash"),
                ];
                if let Some((_, code)) = pairs.iter().find(|(pair, _)| pair.contains(first)) {
                    (*code).into()
                } else if let Some(index) = ")!@#$%^&*(".chars().position(|c| c == first) {
                    format!("Digit{index}")
                } else {
                    String::new()
                }
            }
        } else if raw.bytes().all(|b| b.is_ascii_alphanumeric()) {
            raw.clone()
        } else {
            return Err("browser_key_invalid");
        };
        Ok(Self {
            name: raw,
            code,
            location: 0,
            modifier: 0,
        })
    }
}

impl From<BrowserKey> for String {
    fn from(key: BrowserKey) -> Self {
        if key.modifier != 0 || key.location != 0 {
            key.code
        } else {
            key.name
        }
    }
}

impl BrowserKey {
    pub fn code(&self) -> &str {
        &self.code
    }
    pub fn location(&self) -> u8 {
        self.location
    }
    pub fn modifier(&self) -> u8 {
        self.modifier
    }
    pub fn same_physical_key(&self, other: &Self) -> bool {
        if self.code.is_empty() {
            self.name == other.name
        } else {
            self.code == other.code
        }
    }
    pub fn key(&self, modifiers: u8) -> String {
        if modifiers & 8 == 0 || self.name.chars().count() != 1 {
            return self.name.clone();
        }
        let ch = self.name.chars().next().unwrap();
        if ch.is_ascii_lowercase() {
            return ch.to_ascii_uppercase().to_string();
        }
        let plain = "`1234567890-=[]\\;',./";
        let shifted = "~!@#$%^&*()_+{}|:\"<>?";
        plain
            .chars()
            .position(|c| c == ch)
            .and_then(|i| shifted.chars().nth(i))
            .unwrap_or(ch)
            .to_string()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "String")]
pub struct BrowserKeyChord(Vec<BrowserKey>, String);

impl TryFrom<String> for BrowserKeyChord {
    type Error = &'static str;
    fn try_from(raw: String) -> Result<Self, Self::Error> {
        if raw.len() > 128 {
            return Err("browser_key_invalid");
        }
        let mut rest = raw.as_str();
        let mut keys: Vec<BrowserKey> = Vec::new();
        while let Some((prefix, tail)) = rest.split_once('+') {
            let Ok(key) = BrowserKey::try_from(prefix.to_owned()) else {
                break;
            };
            if key.modifier() == 0 {
                break;
            }
            if !keys.iter().any(|held| held.same_physical_key(&key)) {
                keys.push(key);
            }
            rest = tail;
        }
        keys.push(BrowserKey::try_from(rest.to_owned())?);
        Ok(Self(keys, raw))
    }
}

impl BrowserKeyChord {
    pub fn keys(&self) -> &[BrowserKey] {
        &self.0
    }
    pub fn as_str(&self) -> &str {
        &self.1
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserKeyboardContact {
    pub page: BrowserPageIdentity,
    pub keys: Vec<BrowserKey>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_keys_preserve_contact_identity_and_shifted_text() {
        for raw in [
            "ShiftRight",
            "Ctrl",
            "NumpadEnter",
            "A",
            "KeyA",
            "+",
            "한",
            "🦉",
        ] {
            let key: BrowserKey = serde_json::from_value(serde_json::json!(raw)).unwrap();
            let decoded: BrowserKey =
                serde_json::from_value(serde_json::to_value(&key).unwrap()).unwrap();
            assert_eq!(decoded, key);
            assert!(decoded.same_physical_key(&key));
        }
        let lower = BrowserKey::try_from("a".to_owned()).unwrap();
        let upper = BrowserKey::try_from("KeyA".to_owned()).unwrap();
        assert!(lower.same_physical_key(&upper));
        assert_eq!(upper.key(8), "A");
        assert_eq!(upper.key(0), "a");
        assert_eq!(BrowserKey::try_from("1".to_owned()).unwrap().key(8), "!");
    }

    #[test]
    fn a_chord_keeps_literal_plus_and_rejects_an_incomplete_key() {
        let chord: BrowserKeyChord = serde_json::from_str("\"Ctrl+Control++\"").unwrap();
        assert_eq!(chord.keys().len(), 2);
        assert_eq!(chord.keys()[0].code(), "ControlLeft");
        assert_eq!(chord.keys()[1].key(2), "+");
        for invalid in ["", "Control+", "invalid key", "a\n", "\u{001b}"] {
            assert!(serde_json::from_value::<BrowserKeyChord>(serde_json::json!(invalid)).is_err());
        }
        assert!(BrowserKey::try_from("a".repeat(129)).is_err());
    }
}
