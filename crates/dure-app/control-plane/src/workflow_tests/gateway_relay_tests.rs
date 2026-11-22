use super::*;

const REQUEST: &[u8] = b"request\n";
const RESPONSE: &[u8] = b"response\n";

/// A backend that answers only `delay` after the gateway sent its request.
async fn answer_after(mut backend: UnixStream, delay: Duration) -> Vec<u8> {
    tokio::time::sleep(delay).await;
    // A gateway that already gave up has closed its end; the relay result
    // is what the test asserts.
    let _ = backend.write_all(RESPONSE).await;
    let _ = backend.shutdown().await;
    let mut request = Vec::new();
    let _ = backend.read_to_end(&mut request).await;
    request
}

#[tokio::test(start_paused = true)]
async fn the_gateway_relays_a_journaled_response_slower_than_the_default_deadline() {
    // agent_spawn.apply may answer up to the workflow deadline; the remote
    // host's Run keeps starting either way, so the caller must see its answer.
    let slow = REQUEST_DEADLINE + REQUEST_IO_TIMEOUT + Duration::from_secs(10);
    assert!(slow < WORKFLOW_REQUEST_DEADLINE);
    let (gateway, backend) = UnixStream::pair().unwrap();
    let mut output = Vec::new();

    let (relayed, request) = tokio::join!(
        relay_gateway(gateway, REQUEST, &mut output),
        answer_after(backend, slow),
    );

    relayed.expect("the gateway must wait for a journaled response");
    assert_eq!(request, REQUEST);
    assert_eq!(output, RESPONSE);
}

#[tokio::test(start_paused = true)]
async fn the_gateway_still_gives_up_on_a_backend_that_never_answers() {
    let (gateway, _backend) = UnixStream::pair().unwrap();
    let started = tokio::time::Instant::now();

    let relayed = relay_gateway(gateway, REQUEST, Vec::new()).await;

    assert!(matches!(
        relayed,
        Err(ControlPlaneError::Invalid("gateway response timed out"))
    ));
    let waited = started.elapsed();
    let bound = WORKFLOW_REQUEST_DEADLINE + REQUEST_IO_TIMEOUT;
    assert!(
        waited >= bound && waited < bound + Duration::from_secs(1),
        "{waited:?}"
    );
}
