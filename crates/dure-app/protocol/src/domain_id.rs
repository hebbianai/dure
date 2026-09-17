use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

const MAX_ID_BYTES: usize = 160;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainIdErrorV1 {
    pub value: String,
    pub reason: &'static str,
}

impl fmt::Display for DomainIdErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid durable domain id {:?}: {}",
            self.value, self.reason
        )
    }
}

impl std::error::Error for DomainIdErrorV1 {}

#[doc(hidden)]
pub fn validate_domain_id(value: &str) -> Result<(), DomainIdErrorV1> {
    if value.is_empty() {
        return Err(DomainIdErrorV1 {
            value: value.into(),
            reason: "must not be empty",
        });
    }
    if value.len() > MAX_ID_BYTES {
        return Err(DomainIdErrorV1 {
            value: value.into(),
            reason: "exceeds the bounded identifier length",
        });
    }
    if !value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(DomainIdErrorV1 {
            value: value.into(),
            reason: "must start with an ASCII letter or digit",
        });
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(DomainIdErrorV1 {
            value: value.into(),
            reason: "contains characters outside [A-Za-z0-9._:-]",
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct OperationIdV1(String);

impl OperationIdV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainIdErrorV1> {
        let value = value.into();
        validate_domain_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for OperationIdV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

impl fmt::Display for OperationIdV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_ids_keep_the_shared_bounded_domain_grammar() {
        assert!(OperationIdV1::new("operation:child-1").is_ok());
        assert!(OperationIdV1::new("").is_err());
        assert!(OperationIdV1::new("../operation").is_err());
        assert!(OperationIdV1::new("x".repeat(MAX_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn operation_ids_validate_at_the_serde_boundary() {
        assert!(serde_json::from_str::<OperationIdV1>("\"operation-1\"").is_ok());
        assert!(serde_json::from_str::<OperationIdV1>("\"../operation\"").is_err());
    }
}
