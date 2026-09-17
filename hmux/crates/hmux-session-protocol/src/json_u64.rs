//! Lossless JSON adapter for 64-bit protocol counters.
//!
//! JavaScript numbers cannot represent every `u64`. Canonical decimal strings
//! keep fences and ordering exact across Rust and the intended UI clients, and
//! rejecting alternate spellings prevents two wire forms for the same value.

use serde::{Deserializer, Serializer, de};
use std::fmt;

pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_string())
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_str(DecimalU64Visitor)
}

struct DecimalU64Visitor;

impl de::Visitor<'_> for DecimalU64Visitor {
    type Value = u64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a canonical decimal u64 string")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(E::custom("u64 must use canonical unsigned decimal text"));
        }
        value.parse().map_err(E::custom)
    }
}

/// Optional counters reuse the same canonical decimal encoding. Absence and
/// explicit null both deserialize to `None`, so additive optional fields stay
/// compatible with peers that never emit them.
pub mod option {
    use serde::{Deserializer, Serializer, de};
    use std::fmt;

    pub fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => super::serialize(value, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_option(OptionalDecimalU64Visitor)
    }

    struct OptionalDecimalU64Visitor;

    impl<'de> de::Visitor<'de> for OptionalDecimalU64Visitor {
        type Value = Option<u64>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an optional canonical decimal u64 string")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: Deserializer<'de>,
        {
            super::deserialize(deserializer).map(Some)
        }
    }
}
