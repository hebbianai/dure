use super::*;

const DEVICE: &str = "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screenWidth:screen.width,ua:navigator.userAgent})";

pub(super) async fn exercise(
    home: &Path,
    resource: &str,
    page: &str,
    epoch: &str,
    endpoint: &ControlPlaneEndpoint,
    origin: &str,
    peer: &str,
) -> Result<(), String> {
    let baseline = eval(home, resource, page, epoch, DEVICE).await?;
    let peer_before = eval(home, resource, peer, epoch, DEVICE).await?;
    let applied = write(home, resource, page, epoch, "set", &["device", "iPhone 15"]).await;
    let observed = eval(home, resource, page, epoch, DEVICE).await?;
    println!("BROWSER_DEVICE_FIRST baseline={baseline} command={applied:?} observed={observed}");
    require(
        applied.is_ok()
            && observed["width"] == 393
            && observed["height"] == 852
            && observed["dpr"] == 3
            && observed["screenWidth"] == 393
            && observed["ua"]
                .as_str()
                .is_some_and(|ua| ua.contains("iPhone OS 17_0")),
        (&applied, &observed),
    )?;
    let image = home.join("device-iphone.png");
    cli(
        home,
        &[
            "screenshot",
            resource,
            "--page",
            page,
            "--output",
            image.to_str().unwrap(),
        ],
    )
    .await?;
    require(dimensions(&image)? == (1179, 2556), dimensions(&image))?;
    write(home, resource, page, epoch, "click", &["#corner"]).await?;
    require(
        eval(home, resource, page, epoch, "window.clicks").await? == 1,
        "device corner input missed the emulated viewport",
    )?;
    let mut presets = Vec::new();
    for (name, width, height, scale, ua) in [
        ("IPHONE15", 393, 852, 3.0, "iPhone OS 17_0"),
        ("iPhone 16", 393, 852, 3.0, "iPhone OS 18_0"),
        ("iphone16pro", 402, 874, 3.0, "iPhone OS 18_0"),
        ("iPhone 17", 402, 874, 3.0, "iPhone OS 19_0"),
        ("iPad Air", 820, 1180, 2.0, "iPad; CPU OS 18_0"),
        ("iPad Pro", 1024, 1366, 2.0, "iPad; CPU OS 18_0"),
        ("Pixel 9", 412, 923, 2.625, "Android 15; Pixel 9"),
        ("Galaxy S25", 360, 800, 3.0, "Android 15; SM-S931B"),
        ("iPhone 12", 390, 844, 3.0, "iPhone OS 14_0"),
        ("iPhone 14", 390, 844, 3.0, "iPhone OS 16_0"),
        ("Pixel 5", 393, 851, 2.75, "Android 11; Pixel 5"),
        ("Pixel 7", 412, 915, 2.625, "Android 13; Pixel 7"),
        ("Galaxy S21", 360, 800, 3.0, "Android 11; SM-G991B"),
    ] {
        write(home, resource, page, epoch, "device", &[name]).await?;
        let observed = eval(home, resource, page, epoch, DEVICE).await?;
        require(
            observed["width"] == width
                && observed["height"] == height
                && observed["dpr"] == scale
                && observed["ua"]
                    .as_str()
                    .is_some_and(|value| value.contains(ua)),
            (name, &observed),
        )?;
        presets.push(json!({"name":name,"observed":observed}));
    }
    write(
        home,
        resource,
        page,
        epoch,
        "goto",
        &[&format!("{origin}/device-ua")],
    )
    .await?;
    let navigated = eval(home,resource,page,epoch,"({device:({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ua:navigator.userAgent}),requestUA:window.requestUA})").await?;
    require(
        navigated["device"]["width"] == 360 && navigated["device"]["ua"] == navigated["requestUA"],
        &navigated,
    )?;
    let denied = cli(home, &["device", resource, "iPhone 15", "--page", page]).await;
    require(
        denied
            .as_ref()
            .is_err_and(|error| error.contains("browser_controller_changed")),
        &denied,
    )?;
    let shown = cli(home, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let current_page = shown["result"]["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["page"]["page_id"] == page)
        .unwrap()["page"]
        .clone();
    for action in [
        json!({"kind":"device","name":"constructor"}),
        json!({"kind":"device","name":"iPhone 15","userAgent":"forged"}),
        json!({"kind":"device","name":"iPhone 15","width":1}),
        json!({"kind":"device_reset","name":"iPhone 15"}),
    ] {
        let rejected = backend(endpoint,"browser.resource",json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"device-invalid","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":action}})).await;
        require(rejected.get("error").is_some(), &rejected)?;
    }
    let after_rejected = cli(home, &["show", resource]).await?;
    require(
        after_rejected["result"]["control"] == *control,
        "invalid device mutated Host authority",
    )?;
    require(
        eval(home, resource, peer, epoch, DEVICE).await? == peer_before,
        "device changed peer tab",
    )?;
    let other = cli(home, &["create", "--workspace", "workspace-browser"]).await?;
    let other_id = other["result"]["control"]["resource"]["resource_id"]
        .as_str()
        .ok_or("device peer resource missing")?;
    let isolation: Result<Value, String> = async {
        let shown = cli(home, &["show", other_id]).await?;
        let other_page = shown["result"]["pages"][0]["page"]["page_id"]
            .as_str()
            .ok_or("device peer page missing")?;
        let lease = cli(home, &["control", other_id, "--controller", "agent-proof"]).await?;
        let other_epoch = lease["result"]["controller"]["epoch"]
            .as_str()
            .ok_or("device peer epoch missing")?;
        write(home, other_id, other_page, other_epoch, "goto", &[origin]).await?;
        let state = eval(home, other_id, other_page, other_epoch, DEVICE).await?;
        require(
            ["width", "dpr", "screenWidth", "ua"]
                .iter()
                .all(|key| state[*key] == baseline[*key]),
            (&state, &baseline),
        )?;
        Ok(state)
    }
    .await;
    let retired = cli(home, &["close", other_id]).await;
    let isolated = isolation?;
    retired?;
    // Replay the exact admitted request after losing its client connection.
    // A fresh CLI invocation has a new sequence and is a different request.
    let shown = cli(home, &["show", resource]).await?;
    let control = &shown["result"]["control"];
    let lost = json!({"kind":"action","caller":"agent-proof","authority":{"lease":control["controller"],"page":current_page,"operation_id":"device-lost-client","command_sequence":control["next_command_sequence"]},"action":{"kind":"environment","action":{"kind":"device","name":"iPhone 15"}}});
    let mut socket = UnixStream::connect(&endpoint.socket_path)
        .await
        .map_err(|error| error.to_string())?;
    socket
        .write_all(format!("{}\n", envelope(endpoint, "browser.resource", lost.clone())).as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    drop(socket);
    timeout(Duration::from_secs(10), async {
        loop {
            let receipt = cli(home, &["receipt", "device-lost-client"]).await?;
            if receipt["receipt"]["state"] == "succeeded" {
                return Ok::<_, String>(());
            }
            if receipt["receipt"]["state"] == "failed" {
                return Err(format!("device lost-client failed: {receipt}"));
            }
        }
    })
    .await
    .map_err(|_| "device receipt timeout")??;
    require(
        eval(home, resource, page, epoch, DEVICE).await?["width"] == 393,
        "lost-client device did not apply",
    )?;
    write(home, resource, page, epoch, "device", &["Pixel 9"]).await?;
    let duplicate = backend(endpoint, "browser.resource", lost).await;
    require(duplicate["result"]["replayed"] == true, &duplicate)?;
    let replayed = eval(home, resource, page, epoch, DEVICE).await?;
    require(
        replayed["width"] == 412
            && replayed["ua"]
                .as_str()
                .is_some_and(|ua| ua.contains("Pixel 9")),
        &replayed,
    )?;
    write(home, resource, page, epoch, "viewport", &["reset"]).await?;
    let mut native_view = eval(home, resource, page, epoch, DEVICE).await?;
    require(
        native_view["ua"] == replayed["ua"]
            && ["width", "dpr", "screenWidth"]
                .iter()
                .all(|key| native_view[*key] == baseline[*key]),
        (
            "viewport reset must release device dimensions and retain User-Agent",
            &native_view,
            &baseline,
        ),
    )?;
    // Native window content height can change while another window is active.
    // Reset must restore this window's current native size, not a stale size
    // from the beginning of the fixture or from the independent peer window.
    native_view["ua"] = baseline["ua"].clone();
    write(home, resource, page, epoch, "device", &["iPhone 15"]).await?;
    write(home, resource, page, epoch, "device", &["reset"]).await?;
    let reset = eval(home, resource, page, epoch, DEVICE).await?;
    require(
        reset == native_view,
        (
            "device reset differs from native defaults",
            &reset,
            &native_view,
        ),
    )?;
    require(
        eval(
            home,
            resource,
            page,
            epoch,
            "fetch('/user-agent').then(response=>response.text())",
        )
        .await?
            == baseline["ua"],
        "reset did not restore HTTP User-Agent",
    )?;
    println!(
        "BROWSER_DEVICE_CLI {}",
        json!({"presets":presets,"navigated":navigated,"peerUnchanged":true,"isolated":isolated,"replayed":replayed,"initial":baseline,"nativeDefault":native_view,"reset":reset,"png":[1179,2556],"cornerClicks":1})
    );
    Ok(())
}
