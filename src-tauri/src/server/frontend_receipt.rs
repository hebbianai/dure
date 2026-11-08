use std::io::Cursor;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Request, Response};
use tokio::sync::OwnedSemaphorePermit;

use super::request_broker::RequestWait;
use super::{claimed_request_timeout, json_response, CliRequestBroker, REQUEST_TIMEOUT};

/// Actions whose receipt depends on an SSH host answering. The HTTP server loop
/// is single threaded, so a slow host must not hold it for the whole budget.
pub(super) fn waits_on_remote_host(action: &str) -> bool {
    matches!(action, "hmux.remote-shell" | "project.add")
}

/// Answer for a remote action refused because every receipt worker is in use.
pub(super) fn remote_receipt_busy(action: &str) -> Value {
    if action == "hmux.remote-shell" {
        return json!({ "ok": false, "fallback": true });
    }
    json!({
        "ok": false,
        "error": {
            "code": "remote_requests_busy",
            "message": "Too many remote requests are in progress; try again shortly"
        }
    })
}

pub(super) fn dispatch_frontend_receipt(
    request: Request,
    broker: Arc<CliRequestBroker>,
    request_id: String,
    action: &'static str,
    receiver: mpsc::Receiver<Value>,
    permit: OwnedSemaphorePermit,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("dure-remote-receipt".into())
        .spawn(move || {
            let _permit = permit;
            let response = wait_for_frontend_receipt(&broker, &request_id, action, false, receiver);
            let _ = request.respond(response);
        })
}

fn timeout(request_id: &str, claimed: bool) -> Response<Cursor<Vec<u8>>> {
    json_response(
        504,
        json!({
            "ok": false,
            "error": {
                "code": "frontend_timeout",
                "message": if claimed {
                    "Dure claimed but did not complete the pane request"
                } else {
                    "Dure did not claim the pane request"
                },
                "deliveryState": if claimed { "claimed" } else { "unclaimed" },
                "requestId": request_id
            }
        }),
    )
}

pub(super) fn wait_for_frontend_receipt(
    broker: &CliRequestBroker,
    request_id: &str,
    action: &str,
    replayable: bool,
    receiver: mpsc::Receiver<Value>,
) -> Response<Cursor<Vec<u8>>> {
    let mut remaining = REQUEST_TIMEOUT;
    let mut waiting_for_completion = false;
    loop {
        match receiver.recv_timeout(remaining) {
            Ok(result) => {
                return json_response(
                    if result["ok"] == Value::Bool(true) {
                        200
                    } else {
                        409
                    },
                    result,
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if waiting_for_completion {
                    if !replayable {
                        broker.cancel(request_id);
                    }
                    return timeout(request_id, true);
                }
                match broker.after_timeout(request_id) {
                    Ok(RequestWait::Unclaimed) => return timeout(request_id, false),
                    Ok(RequestWait::DecisionExpired) => {
                        return json_response(409, json!({ "ok": false, "fallback": true }));
                    }
                    Ok(RequestWait::Pending(duration)) => remaining = duration,
                    Ok(RequestWait::Claimed(elapsed)) => {
                        remaining = claimed_request_timeout(action)
                            .saturating_sub(elapsed.unwrap_or(Duration::ZERO));
                        waiting_for_completion = true;
                    }
                    Err(error) => {
                        return json_response(
                            500,
                            json!({ "ok": false, "error": {
                                "code": "broker_unavailable", "message": error
                            }}),
                        );
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if waiting_for_completion {
                    if !replayable {
                        broker.cancel(request_id);
                    }
                    return timeout(request_id, true);
                }
                return json_response(
                    500,
                    json!({ "ok": false, "error": {
                        "code": "broker_disconnected",
                        "message": "Dure pane request broker disconnected"
                    }}),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::thread;
    use tiny_http::Server;
    use tokio::sync::Semaphore;

    fn get(address: SocketAddr, path: &str) -> String {
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            client,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn a_claimed_project_add_is_answered_when_its_ssh_host_is_slower_than_the_generic_budget() {
        let broker = Arc::new(CliRequestBroker::default());
        let receiver = broker.register("project".into()).unwrap();
        assert!(broker.claim("project").unwrap());
        let frontend_broker = broker.clone();
        let frontend = thread::spawn(move || {
            // Past the budget of an action with no entry of its own, yet still
            // shorter than the 10s TCP connect an SSH host is allowed.
            thread::sleep(
                REQUEST_TIMEOUT
                    + super::super::CLAIMED_REQUEST_TIMEOUT
                    + Duration::from_millis(500),
            );
            frontend_broker
                .complete("project", json!({ "ok": true }))
                .unwrap();
        });

        let response =
            wait_for_frontend_receipt(&broker, "project", "project.add", false, receiver);

        assert_eq!(response.status_code().0, 200);
        frontend.join().unwrap();
    }

    #[test]
    fn a_project_add_waiting_on_its_ssh_host_leaves_http_service_available() {
        assert!(waits_on_remote_host("project.add"));
        let server = Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let broker = Arc::new(CliRequestBroker::default());
        let receiver = broker.register("project".into()).unwrap();
        assert!(broker.claim("project").unwrap());
        let permits = Arc::new(Semaphore::new(1));
        let worker_permit = permits.clone().try_acquire_owned().unwrap();
        let worker_broker = broker.clone();
        let (ready, worker_ready) = mpsc::sync_channel(1);
        let loop_thread = thread::spawn(move || {
            let project = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            let worker = dispatch_frontend_receipt(
                project,
                worker_broker,
                "project".into(),
                "project.add",
                receiver,
                worker_permit,
            )
            .unwrap();
            ready.send(()).unwrap();
            let ping = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            assert_eq!(ping.url(), "/ping");
            ping.respond(json_response(200, json!({"ok":true})))
                .unwrap();
            worker.join().unwrap();
        });
        let project = thread::spawn(move || get(address, "/project"));
        worker_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(permits.clone().try_acquire_owned().is_err());

        // Served while the project add above is still waiting for its host.
        assert!(get(address, "/ping").contains("200 OK"));

        broker.complete("project", json!({"ok":true})).unwrap();
        assert!(project.join().unwrap().contains("200 OK"));
        loop_thread.join().unwrap();
        assert!(permits.try_acquire_owned().is_ok());
    }

    #[test]
    fn a_busy_remote_action_keeps_its_own_refusal_shape() {
        assert_eq!(
            remote_receipt_busy("hmux.remote-shell"),
            json!({ "ok": false, "fallback": true })
        );
        let refused = remote_receipt_busy("project.add");
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["code"], "remote_requests_busy");
        assert!(refused.get("fallback").is_none());
    }

    #[test]
    fn a_pending_human_decision_keeps_http_service_available_and_releases_its_permit() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let broker = Arc::new(CliRequestBroker::default());
        let permits = Arc::new(Semaphore::new(1));
        let server_broker = broker.clone();
        let server_permits = permits.clone();
        let (ready, decision_ready) = mpsc::sync_channel(1);
        let loop_thread = thread::spawn(move || {
            let shell = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            let registration = server_broker.register_remote_shell("ssh".into()).unwrap();
            assert_eq!(server_broker.begin_decision("ssh").unwrap(), Some(30_000));
            let worker = dispatch_frontend_receipt(
                shell,
                server_broker,
                "ssh".into(),
                "hmux.remote-shell",
                registration.receiver,
                server_permits.clone().try_acquire_owned().unwrap(),
            )
            .unwrap();
            ready.send(()).unwrap();
            let ping = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            assert_eq!(ping.url(), "/ping");
            ping.respond(json_response(200, json!({"ok":true})))
                .unwrap();
            worker.join().unwrap();
        });
        let shell = thread::spawn(move || get(address, "/ssh"));
        decision_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(permits.clone().try_acquire_owned().is_err());
        assert!(matches!(
            broker.after_timeout("ssh").unwrap(),
            RequestWait::Pending(_)
        ));
        // This completes while the first HTTP request still awaits a decision.
        assert!(get(address, "/ping").contains("200 OK"));
        assert!(broker.claim("ssh").unwrap());
        broker
            .complete("ssh", json!({"ok":false,"fallback":true}))
            .unwrap();
        let response = shell.join().unwrap();
        assert!(response.contains("409 Conflict"));
        assert!(response.contains("\"fallback\":true"));
        loop_thread.join().unwrap();
        assert!(permits.try_acquire_owned().is_ok());
    }
}
