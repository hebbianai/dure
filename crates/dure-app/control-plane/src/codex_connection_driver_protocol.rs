use serde_json::{Value, json};

pub(crate) const THREAD_ATTACH_METHOD: &str = "dure/thread/attach";
pub(crate) const THREAD_ATTACH_CAPABILITY: &str = "/dureConnectionDriver/threadAttach";

pub(crate) fn advertise_thread_attach(initialize_result: &mut Value) -> bool {
    let Some(result) = initialize_result.as_object_mut() else {
        return false;
    };
    result.insert("dureConnectionDriver".into(), json!({ "threadAttach": 1 }));
    true
}

pub(crate) fn supports_thread_attach(initialize_result: &Value) -> bool {
    initialize_result
        .pointer(THREAD_ATTACH_CAPABILITY)
        .and_then(Value::as_u64)
        == Some(1)
}

pub(crate) fn thread_attach_params(method: &str, params: Value) -> Value {
    json!({
        "method": method,
        "params": params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_and_attach_request_share_one_versioned_wire_shape() {
        let mut initialized = json!({ "codexHome": "/profile" });
        assert!(!supports_thread_attach(&initialized));
        assert!(advertise_thread_attach(&mut initialized));
        assert!(supports_thread_attach(&initialized));
        assert_eq!(
            thread_attach_params("thread/start", json!({ "cwd": "/workspace" })),
            json!({
                "method": "thread/start",
                "params": { "cwd": "/workspace" },
            })
        );
    }
}
