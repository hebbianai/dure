use dure_app::DomainStoreErrorV1;

pub(crate) fn identity_conflict(
    entity: &'static str,
    id: &str,
    reason: impl Into<String>,
) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::IdentityConflict {
        entity,
        id: id.into(),
        reason: reason.into(),
    }
}

pub(crate) fn corrupt_identifier(
    field: &'static str,
    error: impl std::fmt::Display,
) -> DomainStoreErrorV1 {
    storage(
        "corrupt_identifier",
        format!("stored {field} is invalid: {error}"),
    )
}

pub(crate) fn corrupt_row(table: &'static str, error: sqlx::Error) -> DomainStoreErrorV1 {
    storage(
        "corrupt_row",
        format!("could not decode a {table} row: {error}"),
    )
}

pub(crate) fn serialization(entity: &'static str, error: serde_json::Error) -> DomainStoreErrorV1 {
    storage(
        "serialization",
        format!("could not encode or decode {entity}: {error}"),
    )
}

pub(crate) fn io(operation: &'static str, error: std::io::Error) -> DomainStoreErrorV1 {
    storage("io", format!("{operation}: {error}"))
}

pub(crate) fn map_sqlx(operation: &'static str, error: sqlx::Error) -> DomainStoreErrorV1 {
    if let sqlx::Error::Database(database_error) = &error {
        let code = database_error.code();
        let message = database_error.message().to_ascii_lowercase();
        if code
            .as_deref()
            .is_some_and(|code| code == "5" || code == "6")
            || message.contains("database is locked")
            || message.contains("database is busy")
        {
            return DomainStoreErrorV1::Busy { operation };
        }
    }
    storage("sqlite", format!("{operation}: {error}"))
}

pub(crate) fn storage(code: &'static str, detail: impl Into<String>) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::Storage {
        code,
        detail: detail.into(),
    }
}
