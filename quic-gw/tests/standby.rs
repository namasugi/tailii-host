// 実 QUIC / socketpair を使う結合テスト。sandbox 外で実行する。
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::{net::SocketAddr, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
use tailii_quic_gw::{
    load_or_create_credentials, make_client_endpoint, make_server_endpoint, read_line,
    run_endpoint_with_services, standby::StandbyOptions, GatewayServices, HEADER_CAP,
};

struct Gateway {
    home: PathBuf,
    endpoint: quinn::Endpoint,
    addr: SocketAddr,
    pin: [u8; 32],
    token: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.endpoint.close(0u32.into(), b"test done");
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}
async fn start(count: usize, behavior: &str) -> Gateway {
    start_with_prelude(count, "", behavior).await
}
async fn start_with_prelude(count: usize, prelude: &str, behavior: &str) -> Gateway {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    // 短い一時 HOME だけを使う。固定コマンドの ~ 展開もこちらへ向ける。
    let home = std::env::temp_dir().join(format!(
        "tgw-{}-{:x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::create_dir_all(home.join(".local/bin")).unwrap();
    let shim = home.join(".local/bin/tailii-host");
    // 通常経路も実 host は起動せず、一時 HOME の偽シムだけを呼ぶ。
    std::fs::write(&shim, "#!/bin/sh\nprintf 'normal\\n'\nexec cat\n").unwrap();
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)).unwrap();
    let script = home.join("standby.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho $$ > '{0}/ready'\necho $$ >> '{0}/starts'\n{prelude}\nIFS= read -r request <&3\nprintf '%s\\n' \"$request\" > '{0}/activation'\n{behavior}\n",
            home.display()
        ),
    )
    .unwrap();
    let creds = load_or_create_credentials(&home.join("credentials")).unwrap();
    let pin = B64.decode(creds.cert_pin()).unwrap().try_into().unwrap();
    let token = creds.token_b64();
    let endpoint = make_server_endpoint(&creds, 0).unwrap();
    let addr = SocketAddr::from(([127, 0, 0, 1], endpoint.local_addr().unwrap().port()));
    let server = endpoint.clone();
    let options = StandbyOptions {
        count,
        command: format!("exec /bin/sh '{}'", script.display()),
        shim_path: shim,
        ack_timeout: Duration::from_millis(100),
        home: Some(home.clone()),
    };
    let exec_home = home.clone();
    let task = tokio::spawn(async move {
        run_endpoint_with_services(
            server,
            creds,
            None,
            GatewayServices {
                standby: Some(options),
                exec_home: Some(exec_home),
                ..GatewayServices::default()
            },
        )
        .await
        .unwrap();
    });
    if count > 0 {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_to_string(home.join("ready")).is_ok_and(|s| !s.trim().is_empty()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    Gateway {
        home,
        endpoint,
        addr,
        pin,
        token,
        task,
    }
}

async fn run_exec(gw: &Gateway, cmd: &str, expected: &str) {
    let client = make_client_endpoint(gw.pin).unwrap();
    let conn = client.connect(gw.addr, "tailii").unwrap().await.unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = serde_json::json!({"t":"exec", "v":1, "token":gw.token, "cmd":cmd});
    send.write_all(format!("{header}\n").as_bytes())
        .await
        .unwrap();
    // ACK より先に送った入力も、standby の制御 ACK 後にだけ配管される。
    send.write_all(b"payload\n").await.unwrap();
    send.finish().unwrap();
    assert_eq!(
        read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap(),
        "{\"ok\":true}"
    );
    let out = recv.read_to_end(4096).await.unwrap();
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!("{expected}\npayload\n")
    );
}

#[tokio::test]
async fn handoff_roundtrips_bytes() {
    let gw = start(
        1,
        "printf '{\"ok\":true}\\n' >&3\nexec 3>&-\nprintf 'standby\\n'\nexec cat",
    )
    .await;
    run_exec(&gw, "~/.local/bin/tailii-host engine", "standby").await;
    let activation: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(gw.home.join("activation")).unwrap())
            .unwrap();
    assert_eq!(
        activation,
        serde_json::json!({"activate":{"argv":["engine"]}})
    );
}

#[tokio::test]
async fn rejected_activation_falls_back() {
    let gw = start(1, "printf '{\"ok\":false,\"reason\":\"stale\"}\\n' >&3").await;
    run_exec(&gw, "~/.local/bin/tailii-host engine", "normal").await;
}
#[tokio::test]
async fn timeout_falls_back() {
    let gw = start(1, "exec sleep 10").await;
    run_exec(&gw, "~/.local/bin/tailii-host engine", "normal").await;
}
#[tokio::test]
async fn eof_falls_back() {
    let gw = start(1, "exit 0").await;
    run_exec(&gw, "~/.local/bin/tailii-host engine", "normal").await;
}
#[tokio::test]
async fn unmatched_command_and_zero_pool_use_normal_spawn() {
    let gw = start(
        1,
        "printf '{\"ok\":true}\\n' >&3\nprintf 'standby\\n'\nexec cat",
    )
    .await;
    run_exec(&gw, "~/.local/bin/tailii-host engine; :", "normal").await;
    let disabled = start(0, "exit 1").await;
    run_exec(&disabled, "~/.local/bin/tailii-host engine", "normal").await;
}
#[tokio::test]
async fn replaced_shim_discards_standbys() {
    let gw = start(
        1,
        "printf '{\"ok\":true}\\n' >&3\nprintf 'standby\\n'\nexec cat",
    )
    .await;
    let shim = gw.home.join(".local/bin/tailii-host");
    let replacement = gw.home.join("replacement");
    std::fs::copy(&shim, &replacement).unwrap();
    std::fs::rename(&replacement, &shim).unwrap();
    run_exec(&gw, "~/.local/bin/tailii-host engine", "normal").await;
}

#[tokio::test]
async fn fallback_wrapped_serve_is_also_activated() {
    let gw = start(
        1,
        "printf '{\"ok\":true}\\n' >&3\nexec 3>&-\nprintf 'standby\\n'\nexec cat",
    )
    .await;
    let sub = "serve --session session-1 --client-id 01234567-89ab-cdef-0123-456789abcdef";
    let cmd = format!("~/.local/bin/tailii-host {sub}; s=$?; if [ $s -eq 126 ] || [ $s -eq 127 ]; then exec ~/.local/bin/tailii-host.prev {sub}; fi; exit $s");
    run_exec(&gw, &cmd, "standby").await;
    let activation: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(gw.home.join("activation")).unwrap())
            .unwrap();
    assert_eq!(
        activation["activate"]["argv"],
        serde_json::json!([
            "serve",
            "--session",
            "session-1",
            "--client-id",
            "01234567-89ab-cdef-0123-456789abcdef"
        ])
    );
}

#[tokio::test]
async fn used_standby_is_replenished() {
    let gw = start(
        1,
        "printf '{\"ok\":true}\\n' >&3\nexec 3>&-\nprintf 'standby\\n'\nexec cat",
    )
    .await;
    run_exec(&gw, "~/.local/bin/tailii-host engine", "standby").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while std::fs::read_to_string(gw.home.join("starts"))
            .unwrap_or_default()
            .lines()
            .count()
            < 2
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    run_exec(&gw, "~/.local/bin/tailii-host engine", "standby").await;
}

#[tokio::test]
async fn gateway_shutdown_reaps_idle_standby() {
    let gw = start(1, "exit 0").await;
    let pid: libc::pid_t = std::fs::read_to_string(gw.home.join("ready"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    gw.task.abort();
    tokio::time::timeout(Duration::from_secs(5), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failure_after_ten_seconds_still_backs_off() {
    let gw = start_with_prelude(1, "sleep 11; exit 1", "").await;
    tokio::time::sleep(Duration::from_secs(15)).await;
    // 旧実装なら 13 秒ほどで補充してしまう。
    assert_eq!(std::fs::read_to_string(gw.home.join("starts")).unwrap().lines().count(), 1);
    tokio::time::timeout(Duration::from_secs(30), async {
        while std::fs::read_to_string(gw.home.join("starts")).unwrap().lines().count() < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.unwrap();
}

#[tokio::test]
async fn clean_exit_after_ten_seconds_replenishes_normally() {
    let gw = start_with_prelude(1, "sleep 11; exit 0", "").await;
    tokio::time::timeout(Duration::from_secs(16), async {
        while std::fs::read_to_string(gw.home.join("starts")).unwrap().lines().count() < 2 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.unwrap();
}
