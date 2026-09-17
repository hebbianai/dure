use super::*;

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn zero_probes_preserve_selector_states_and_literal_url_patterns() {
    let (runtime, identity, root) = super::super::authority::launch("wait:boundaries").await;
    let evidence: Result<_, BrowserRuntimeError> = async {
        let page = first_page(&runtime).await?;
        let lease = runtime.request_control(BrowserControllerId::new("agent").unwrap(),None).await?.controller.unwrap();
        apply(&runtime,&lease,&page,json!({"kind":"evaluate","script":"document.body.innerHTML='<div id=shown>한글 준비</div><div id=hidden hidden>Hidden</div><div id=transparent style=opacity:0>Transparent</div><div id=zero style=\"width:0;height:0\"></div>';location.hash='a.b/ready/ready';true"})).await?;
        let page = first_page(&runtime).await?;
        let before = runtime.control().await;
        let mut cases = Vec::new();
        for (selector,state,expected) in [
            ("#shown","attached",true),("#absent","attached",false),
            ("#shown","detached",false),("#absent","detached",true),
            ("#shown","visible",true),("#hidden","visible",false),
            ("#hidden","hidden",true),("#shown","hidden",false),
            ("#absent","hidden",true),("#absent","visible",false),
            ("#transparent","visible",true),("#transparent","hidden",true),
            ("#zero","visible",false),("#zero","hidden",false),
            ("xpath=//div[@id='shown']","visible",true),
            ("xpath=//div[@id='absent']","detached",true),
        ] {
            cases.push((json!({"kind":"selector","target":{"kind":"css","selector":selector},"state":state}),expected));
        }
        for (pattern,expected) in [
            ("a.b",true),("a+b",false),("[ab]",false),("*",true),
            ("**/ready",true),("about:blank#**/ready",true),
            ("blank#*",false),("**/rea",false),("**ready*ready",true),
            ("**ready*ready*ready",false),("**ready*a.b*",false),
            ("about:blank#*ready*",true),
        ] { cases.push((json!({"kind":"url","pattern":pattern}),expected)); }
        cases.push((json!({"kind":"text","text":"한글 준비"}),true));
        cases.push((json!({"kind":"text","text":"없는 글"}),false));
        cases.push((json!({"kind":"duration"}),true));
        let mut results = Vec::new();
        for (condition,expected) in cases {
            let result = runtime.wait(&page,&serde_json::from_value(json!({"condition":condition,"timeout_ms":0})).unwrap()).await;
            results.push((condition,expected,result));
        }
        let invalid = runtime.wait(&page,&serde_json::from_value(json!({"condition":{"kind":"selector","target":{"kind":"css","selector":"["},"state":"attached"},"timeout_ms":1000})).unwrap()).await;
        let started = Instant::now();
        let deadline = runtime.wait(&page,&serde_json::from_value(json!({"condition":{"kind":"text","text":"never present"},"timeout_ms":150})).unwrap()).await;
        let elapsed = started.elapsed();
        Ok((results,invalid,deadline,elapsed,before,runtime.control().await))
    }.await;
    let retired = runtime.close(&identity).await;
    println!(
        "BROWSER_WAIT_BOUNDARIES root={} evidence={evidence:?} retired={retired:?}",
        root.display()
    );
    assert!(retired.is_ok(), "{retired:?}");
    let (results, invalid, deadline, elapsed, before, after) = evidence.unwrap();
    for (condition, expected, result) in results {
        if expected {
            assert_eq!(result.unwrap()["waited"], true, "{condition}");
        } else {
            assert!(
                matches!(
                    result,
                    Err(BrowserRuntimeError::Observation("browser_wait_timeout"))
                ),
                "{condition}: {result:?}"
            );
        }
    }
    assert!(
        matches!(
            invalid,
            Err(BrowserRuntimeError::Observation("browser_selector_invalid"))
        ),
        "{invalid:?}"
    );
    assert!(
        matches!(
            deadline,
            Err(BrowserRuntimeError::Observation("browser_wait_timeout"))
        ),
        "{deadline:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(150) && elapsed < Duration::from_secs(1),
        "{elapsed:?}"
    );
    assert_eq!(before, after);
}

#[tokio::test]
#[ignore = "requires the pinned native engine and Chromium paths"]
async fn condition_and_literal_waits_end_on_host_lifecycle_loss() {
    for condition in [
        json!({"kind":"text","text":"never present"}),
        json!({"kind":"duration"}),
    ] {
        for retire in [false, true] {
            let (runtime, identity, root) = super::super::authority::launch("wait:lifetime").await;
            let evidence: Result<_, BrowserRuntimeError> = async {
                let page = first_page(&runtime).await?;
                let request =
                    serde_json::from_value(json!({"condition":condition,"timeout_ms":10000}))
                        .unwrap();
                let wait = runtime.wait(&page, &request);
                tokio::pin!(wait);
                let pending = timeout(Duration::from_millis(250), wait.as_mut()).await;
                if retire {
                    runtime.begin_retirement(&identity).await?;
                } else {
                    runtime.test_binding().events.close().await;
                }
                let ended = timeout(Duration::from_secs(2), wait).await;
                Ok((pending, ended))
            }
            .await;
            let retired = runtime.close(&identity).await;
            println!(
                "BROWSER_WAIT_LIFETIME condition={condition} retire={retire} root={} evidence={evidence:?} retired={retired:?}",
                root.display()
            );
            assert!(retired.is_ok(), "{retired:?}");
            let (pending, ended) = evidence.unwrap();
            assert!(pending.is_err(), "{pending:?}");
            assert!(
                matches!(
                    ended,
                    Ok(Err(BrowserRuntimeError::Observation(
                        "browser_renderer_lifecycle_changed" | "browser_network_observation_lost"
                    ))) | Ok(Err(BrowserRuntimeError::Admission(
                        BrowserAdmissionError::ResourceRetiring
                    )))
                ),
                "{ended:?}"
            );
        }
    }
}
