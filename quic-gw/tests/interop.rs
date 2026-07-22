// tailii-quic-gw 統合テスト — ワイヤー仕様 v1 の in-process 検証
//
// サーバ endpoint を port 0 で立て、quinn クライアントで exec / exec+pty / tcp /
// 認証・プロトコル拒否 / FIN 伝播を検証する。ネットワークはループバックのみ。

use std::net::SocketAddr;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use tailii_quic_gw::{
    load_or_create_credentials, make_client_endpoint, make_server_endpoint, read_line,
    run_endpoint, Credentials, HEADER_CAP,
};

struct TestGateway {
    addr: SocketAddr,
    cert_pin: [u8; 32],
    token_b64: String,
    _dir: tempdir::TempDir,
}

/// 依存を増やさない最小 tempdir（テスト専用）。
mod tempdir {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "quicgw-interop-{label}-{}-{:x}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

async fn start_gateway(label: &str) -> TestGateway {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let dir = tempdir::TempDir::new(label);
    let creds = load_or_create_credentials(dir.path()).unwrap();
    let cert_pin: [u8; 32] = B64
        .decode(creds.cert_pin())
        .unwrap()
        .try_into()
        .unwrap();
    let token_b64 = creds.token_b64();
    let endpoint = make_server_endpoint(&creds, 0).unwrap();
    let addr = SocketAddr::from(([127, 0, 0, 1], endpoint.local_addr().unwrap().port()));

    // run_endpoint は accept ループに入ったまま返らないので detach する。
    let serve_creds = Credentials {
        cert_der: creds.cert_der.clone(),
        key_der: creds.key_der.clone_key(),
        spki_der: creds.spki_der.clone(),
        token: creds.token.clone(),
    };
    tokio::spawn(async move {
        let _ = run_endpoint(endpoint, serve_creds, None).await;
    });

    TestGateway {
        addr,
        cert_pin,
        token_b64,
        _dir: dir,
    }
}

async fn connect(gw: &TestGateway) -> (quinn::Endpoint, quinn::Connection) {
    let endpoint = make_client_endpoint(gw.cert_pin).unwrap();
    let conn = endpoint.connect(gw.addr, "tailii").unwrap().await.unwrap();
    (endpoint, conn)
}

#[tokio::test]
async fn exec_pipes_stdio_and_propagates_fin() {
    let gw = start_gateway("exec").await;
    let (_endpoint, conn) = connect(&gw).await;

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":\"cat\"}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"), "unexpected response: {ok}");

    send.write_all(b"hello-exec\n").await.unwrap();
    let echoed = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert_eq!(echoed, "hello-exec");

    // クライアント FIN → cat の stdin EOF → プロセス終了 → サーバ FIN。
    send.finish().unwrap();
    let fin = read_line(&mut recv, HEADER_CAP).await.unwrap();
    assert!(fin.is_none(), "expected FIN, got {fin:?}");
}

#[tokio::test]
async fn exec_stdin_eof_reaches_process() {
    let gw = start_gateway("eof").await;
    let (_endpoint, conn) = connect(&gw).await;

    // cat が EOF で終わってから done を出す = FIN が stdin EOF として届いた証拠。
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":\"cat >/dev/null; echo done\"}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"));
    send.write_all(b"swallowed\n").await.unwrap();
    send.finish().unwrap();
    let done = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert_eq!(done, "done");
}

#[tokio::test]
async fn exec_pty_runs_command_on_terminal() {
    let gw = start_gateway("pty").await;
    let (_endpoint, conn) = connect(&gw).await;

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    // tty コマンドの終了コードで「本当に PTY 上か」を判定する（PTY 上なら 0）。
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":\"tty >/dev/null && printf pty-yes || printf pty-no; printf '\\\\n'; printf %s \\\"$TERM\\\"\",\"pty\":{{\"cols\":81,\"rows\":25,\"term\":\"xterm-256color\"}}}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"), "unexpected response: {ok}");

    let mut out = Vec::new();
    let mut buf = vec![0u8; 4096];
    while let Some(n) = recv.read(&mut buf).await.unwrap() {
        out.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("pty-yes"), "not on a pty: {text:?}");
    assert!(text.contains("xterm-256color"), "TERM not set: {text:?}");
}

#[tokio::test]
async fn pty_client_reset_hangs_up_session() {
    // 静かな PTY（出力なし）でもクライアント消失（reset）で SIGHUP が届き、
    // セッションが残留しないことの回帰固定（tmux client 残留 = reaper attach 保護の
    // 永続化バグの根）。HUP トラップでマーカーを書く常駐プロセスを立て、
    // ストリーム reset 後にマーカーが現れることを確認する。
    let gw = start_gateway("ptyhup").await;
    let (_endpoint, conn) = connect(&gw).await;

    let marker = std::env::temp_dir().join(format!(
        "quicgw-hup-{}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&marker);

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let cmd = format!(
        "trap 'touch {}; exit 0' HUP; echo ready; while :; do sleep 0.2; done",
        marker.display()
    );
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":{},\"pty\":{{\"cols\":80,\"rows\":24}}}}\n",
        gw.token_b64,
        serde_json::to_string(&cmd).unwrap()
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"), "unexpected response: {ok}");
    let ready = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ready.starts_with("ready"), "expected ready marker: {ready:?}");

    // クライアント消失を模擬: 両方向を reset する（FIN ではない）。
    send.reset(0u32.into()).unwrap();
    let _ = recv.stop(0u32.into());

    // gateway が master を閉じ、SIGHUP → trap → マーカー生成、まで待つ。
    let mut hung_up = false;
    for _ in 0..100 {
        if marker.exists() {
            hung_up = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let _ = std::fs::remove_file(&marker);
    assert!(hung_up, "PTY session was not hung up after client reset");
}

#[tokio::test]
async fn pty_client_fin_hangs_up_session() {
    // クライアント FIN（正常クローズ）でも静かな PTY セッションを破棄することの回帰固定。
    // iOS の closeInteractiveShell（NWConnection.cancel）は QUIC 上では reset ではなく
    // FIN として届く — FIN を「入力終了・セッション維持」にしていた旧実装では、無出力の
    // シェルが誰にも回収されず pty master fd が蓄積し EMFILE で全 exec 不能に至った
    // （実機障害 2026-07-23: 1.5 日で 240 個 / soft limit 256）。
    let gw = start_gateway("ptyfin").await;
    let (_endpoint, conn) = connect(&gw).await;

    let marker = std::env::temp_dir().join(format!(
        "quicgw-fin-{}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&marker);

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let cmd = format!(
        "trap 'touch {}; exit 0' HUP; echo ready; while :; do sleep 0.2; done",
        marker.display()
    );
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":{},\"pty\":{{\"cols\":80,\"rows\":24}}}}\n",
        gw.token_b64,
        serde_json::to_string(&cmd).unwrap()
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"), "unexpected response: {ok}");
    let ready = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ready.starts_with("ready"), "expected ready marker: {ready:?}");

    // 正常クローズを模擬: 書き込み側 FIN のみ（受信側は開けたまま）。
    send.finish().unwrap();

    let mut hung_up = false;
    for _ in 0..100 {
        if marker.exists() {
            hung_up = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let _ = std::fs::remove_file(&marker);
    assert!(hung_up, "PTY session was not hung up after client FIN");
}

#[tokio::test]
async fn tcp_pipes_to_loopback_and_half_closes() {
    let gw = start_gateway("tcp").await;
    let (_endpoint, conn) = connect(&gw).await;

    // エコーしてから相手の EOF を待って閉じるループバックサーバ。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tcp_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = vec![0u8; 1024];
            loop {
                match socket.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"tcp\",\"v\":1,\"token\":\"{}\",\"port\":{tcp_port}}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"), "unexpected response: {ok}");

    send.write_all(b"tcp-roundtrip\n").await.unwrap();
    let echoed = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert_eq!(echoed, "tcp-roundtrip");

    // クライアント FIN → TCP write half close → エコーサーバ終了 → サーバ FIN。
    send.finish().unwrap();
    let fin = read_line(&mut recv, HEADER_CAP).await.unwrap();
    assert!(fin.is_none(), "expected FIN, got {fin:?}");
}

#[tokio::test]
async fn tcp_connect_failure_reports_connect_error() {
    let gw = start_gateway("tcpfail").await;
    let (_endpoint, conn) = connect(&gw).await;

    // 空きポートを掴んで即閉じ、確実に接続不能なポートを得る。
    let closed_port = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"tcp\",\"v\":1,\"token\":\"{}\",\"port\":{closed_port}}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let response = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(
        response.contains("\"err\":\"connect\""),
        "expected connect error: {response}"
    );
}

#[tokio::test]
async fn rejects_bad_token_and_unknown_kind() {
    let gw = start_gateway("reject").await;
    let (_endpoint, conn) = connect(&gw).await;

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(b"{\"t\":\"exec\",\"v\":1,\"token\":\"AAAA\",\"cmd\":\"true\"}\n")
        .await
        .unwrap();
    let rejected = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(rejected.contains("\"err\":\"auth\""), "expected auth: {rejected}");

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"shell\",\"v\":1,\"token\":\"{}\"}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let rejected = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(rejected.contains("\"err\":\"proto\""), "expected proto: {rejected}");

    // exec で cmd 欠落も proto。
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!("{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\"}}\n", gw.token_b64);
    send.write_all(header.as_bytes()).await.unwrap();
    let rejected = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(rejected.contains("\"err\":\"proto\""), "expected proto: {rejected}");
}

#[tokio::test]
async fn diagnostic_echo_still_works() {
    let gw = start_gateway("diag").await;
    let (_endpoint, conn) = connect(&gw).await;

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!("{{\"t\":\"echo\",\"v\":1,\"token\":\"{}\"}}\n", gw.token_b64);
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"));
    send.write_all(b"ping\n").await.unwrap();
    let back = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert_eq!(back, "ping");
    send.finish().unwrap();
    let fin = read_line(&mut recv, HEADER_CAP).await.unwrap();
    assert!(fin.is_none());
}

#[tokio::test]
async fn exec_injects_gateway_path() {
    let gw = start_gateway("path").await;
    let (_endpoint, conn) = connect(&gw).await;

    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let header = format!(
        "{{\"t\":\"exec\",\"v\":1,\"token\":\"{}\",\"cmd\":\"printf %s \\\"$PATH\\\"\"}}\n",
        gw.token_b64
    );
    send.write_all(header.as_bytes()).await.unwrap();
    let ok = read_line(&mut recv, HEADER_CAP).await.unwrap().unwrap();
    assert!(ok.contains("\"ok\":true"));
    send.finish().unwrap();

    let mut out = Vec::new();
    let mut buf = vec![0u8; 4096];
    while let Some(n) = recv.read(&mut buf).await.unwrap() {
        out.extend_from_slice(&buf[..n]);
    }
    let path = String::from_utf8_lossy(&out);
    assert!(
        path.contains("/opt/homebrew/bin") && path.contains(".local/bin"),
        "injected PATH missing entries: {path:?}"
    );
}
