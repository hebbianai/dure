//! Canonical byte encoding shared with persisted presentation checkpoints.
//! The public module supports Serde's `with` adapter across the storage boundary.

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use serde::{Deserialize, Deserializer, Serializer, de};

pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&STANDARD_NO_PAD.encode(bytes))
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    let encoded = String::deserialize(deserializer)?;
    STANDARD_NO_PAD.decode(encoded).map_err(de::Error::custom)
}
