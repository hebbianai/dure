use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

// Consume the same deserialize_any path as Value without retaining its tree.
// IgnoredAny instead uses skip parsing, which can accept out-of-range numbers
// and bypass the normal nested-container depth checks.
pub(super) struct ValidatedJson;

impl<'de> Deserialize<'de> for ValidatedJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Self)
    }
}

impl<'de> Visitor<'de> for ValidatedJson {
    type Value = Self;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self, A::Error> {
        while sequence.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        while map.next_entry::<Self, Self>()?.is_some() {}
        Ok(self)
    }
}
