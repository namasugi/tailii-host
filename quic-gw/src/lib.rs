// tailii-quic-gw — QUIC ゲートウェイ本体（M1）
//
// 設計正本: docs/quic-transport.md（リポジトリルート）。
// 責務は「認証して、ストリームをプロセス stdio / TCP に配管する」だけ。
// engine の翻訳ロジック・hub・プロトコル定義は host-ts に残る。
//
// ワイヤー仕様 v1:
//   ヘッダ（クライアント→GW, NDJSON 1行）:
//     { "t": "exec", "v": 1, "token": "<b64>", "cmd": "...",
//       "pty": { "cols": 80, "rows": 24, "term": "xterm-256color" }? }
//     { "t": "tcp",  "v": 1, "token": "<b64>", "port": 49152 }
//     診断 kind（副作用なし・M0 プローブ互換）: echo / sink / source
//   応答（GW→クライアント, NDJSON 1行）:
//     { "ok": true } / { "ok": false, "err": "auth" | "spawn" | "connect" | "proto" }
//
// 0-RTT 規律: early data の受信は許可するが、副作用（プロセス spawn / TCP 接続）は
// TLS handshake confirmed 後にのみ実行する（診断 kind は副作用なしのため即時可）。

use std::net::SocketAddr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

pub const ALPN: &[u8] = b"tailii/1";
pub const DEFAULT_PORT: u16 = 46853;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
pub const KEEPALIVE: Duration = Duration::from_secs(20);
pub const HEADER_CAP: usize = 4096;
const SOURCE_CAP: u64 = 512 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

// ---------------------------------------------------------------- 共通ヘルパ

pub fn expand_home(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", std::env::var("HOME").unwrap_or_default()),
        None => p.to_string(),
    }
}

pub fn default_credentials_dir() -> PathBuf {
    PathBuf::from(expand_home("~/.tailii/quic"))
}

/// launch.ts の `defaultInjectedPath()` と同一の PATH（SSH 非ログインシェルと同等の環境）。
/// 変更時は host-ts/src/launch.ts と同期すること。
pub fn default_injected_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        "/opt/homebrew/bin".to_string(),
        format!("{home}/.local/bin"),
        format!("{home}/.local/share/mise/shims"),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]
    .join(":")
}

pub fn sha256_b64(bytes: &[u8]) -> String {
    B64.encode(Sha256::digest(bytes))
}

/// 定数時間比較（長さ不一致は即 false だが、トークン長は公開情報なので問題ない）。
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn log_line(msg: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    println!("[{}.{:03}] {msg}", now.as_secs(), now.subsec_millis());
}

// ---------------------------------------------------------------- 資格情報

pub struct Credentials {
    pub cert_der: CertificateDer<'static>,
    pub key_der: PrivateKeyDer<'static>,
    pub spki_der: Vec<u8>,
    pub token: Vec<u8>,
}

impl Credentials {
    pub fn spki_pin(&self) -> String {
        sha256_b64(&self.spki_der)
    }
    pub fn cert_pin(&self) -> String {
        sha256_b64(&self.cert_der)
    }
    pub fn token_b64(&self) -> String {
        B64.encode(&self.token)
    }
}

/// `dir` の cert.pem / key.pem / token を読み込む（無ければ生成する・冪等）。
/// 証明書は ECDSA P-256 固定（iOS SecKey が ed25519 の SPKI 再構成に非対応のため）。
pub fn load_or_create_credentials(dir: &Path) -> Result<Credentials> {
    std::fs::create_dir_all(dir)?;
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    let token_path = dir.join("token");

    if !cert_path.exists() || !key_path.exists() {
        let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let params = rcgen::CertificateParams::new(vec!["tailii".to_string()])?;
        let cert = params.self_signed(&key_pair)?;
        write_private(&cert_path, cert.pem().as_bytes())?;
        write_private(&key_path, key_pair.serialize_pem().as_bytes())?;
    }
    if !token_path.exists() {
        let token: [u8; 32] = rand::random();
        write_private(&token_path, B64.encode(token).as_bytes())?;
    }

    let cert_pem = std::fs::read(&cert_path)?;
    let cert_der = rustls_pemfile::certs(&mut cert_pem.as_slice())
        .next()
        .context("no certificate in cert.pem")??;
    let key_pem = std::fs::read(&key_path)?;
    let key_der = rustls_pemfile::private_key(&mut key_pem.as_slice())?
        .context("no private key in key.pem")?;
    let key_pair = rcgen::KeyPair::from_pem(std::str::from_utf8(&key_pem)?)?;
    let spki_der = key_pair.public_key_der();
    let token_b64 = std::fs::read_to_string(&token_path)?;
    let token = B64
        .decode(token_b64.trim())
        .context("token file is not base64")?;

    Ok(Credentials {
        cert_der,
        key_der,
        spki_der,
        token,
    })
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

// ---------------------------------------------------------------- ストリームヘッダ

#[derive(serde::Deserialize)]
pub struct PtyRequest {
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub term: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct StreamHeader {
    pub t: String,
    pub v: u32,
    pub token: String,
    /// kind=exec: `/bin/sh -c` で実行するコマンドライン。
    #[serde(default)]
    pub cmd: Option<String>,
    /// kind=exec: 指定時は PTY 上で実行する（対話シェル / tmux attach 用）。
    #[serde(default)]
    pub pty: Option<PtyRequest>,
    /// kind=tcp: 接続先ポート（ホストは 127.0.0.1 固定）。
    #[serde(default)]
    pub port: Option<u16>,
    /// kind=source（診断）: 送出バイト数。
    #[serde(default)]
    pub bytes: Option<u64>,
}

/// ストリームから改行までを読み取る（改行は含めない）。FIN 到達で None。
pub async fn read_line(recv: &mut quinn::RecvStream, cap: usize) -> Result<Option<String>> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match recv.read(&mut byte).await? {
            None => {
                if line.is_empty() {
                    return Ok(None);
                }
                bail!("stream ended mid-line");
            }
            Some(0) => continue,
            Some(_) => {
                if byte[0] == b'\n' {
                    return Ok(Some(String::from_utf8(line)?));
                }
                line.push(byte[0]);
                if line.len() > cap {
                    bail!("header line too long");
                }
            }
        }
    }
}

async fn reject(send: &mut quinn::SendStream, err: &str) -> Result<()> {
    let line = format!("{{\"ok\":false,\"err\":\"{err}\"}}\n");
    send.write_all(line.as_bytes()).await?;
    let _ = send.finish();
    Ok(())
}

// ---------------------------------------------------------------- サーバ

pub struct GatewayOptions {
    pub dir: PathBuf,
    pub port: u16,
    /// exec spawn に注入する PATH。None なら `default_injected_path()`。
    pub injected_path: Option<String>,
}

impl Default for GatewayOptions {
    fn default() -> Self {
        GatewayOptions {
            dir: default_credentials_dir(),
            port: DEFAULT_PORT,
            injected_path: None,
        }
    }
}

/// サーバ endpoint を構築して bind する（accept ループは `run_endpoint`）。
pub fn make_server_endpoint(creds: &Credentials, port: u16) -> Result<quinn::Endpoint> {
    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![creds.cert_der.clone()], creds.key_der.clone_key())?;
    crypto.alpn_protocols = vec![ALPN.to_vec()];
    crypto.max_early_data_size = u32::MAX;

    let mut server_config =
        quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(crypto)?));
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(Some(IDLE_TIMEOUT.try_into()?));
    server_config.transport_config(Arc::new(transport));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    Ok(quinn::Endpoint::server(server_config, addr)?)
}

/// serve モード本体。資格情報を用意し、endpoint を bind して accept ループに入る。
pub async fn serve(options: GatewayOptions) -> Result<()> {
    let creds = load_or_create_credentials(&options.dir)?;
    let endpoint = make_server_endpoint(&creds, options.port)?;
    let local = endpoint.local_addr()?;

    // 監査ログはすべて stdout（launchd が ~/.tailii/quic-gw.log へリダイレクトする）。
    // トークンは秘匿情報のためログに出さない（`credentials --json` でのみ取得可能）。
    log_line(&format!(
        "tailii-quic-gw serve listen={local} alpn={} dir={} pin(spki)={}",
        String::from_utf8_lossy(ALPN),
        options.dir.display(),
        creds.spki_pin(),
    ));
    run_endpoint(endpoint, creds, options.injected_path).await
}

/// accept ループ（テストは port=0 の endpoint を渡して並走させる）。
pub async fn run_endpoint(
    endpoint: quinn::Endpoint,
    creds: Credentials,
    injected_path: Option<String>,
) -> Result<()> {
    let token = Arc::new(creds.token.clone());
    let path = Arc::new(injected_path.unwrap_or_else(default_injected_path));
    while let Some(incoming) = endpoint.accept().await {
        let token = token.clone();
        let path = path.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_incoming(incoming, token, path).await {
                log_line(&format!("connection error: {e:#}"));
            }
        });
    }
    Ok(())
}

async fn handle_incoming(
    incoming: quinn::Incoming,
    token: Arc<Vec<u8>>,
    injected_path: Arc<String>,
) -> Result<()> {
    let connecting = incoming.accept()?;
    // 0-RTT を受理する。early data はストリームヘッダの受信までに留め、副作用
    // （spawn / TCP 接続）は handshake confirmed（hs_rx=true）後にのみ実行する。
    let (hs_tx, hs_rx) = watch::channel(false);
    let conn = match connecting.into_0rtt() {
        Ok((conn, accepted)) => {
            tokio::spawn(async move {
                let used = accepted.await;
                // used=false は 0-RTT 拒否（リプレイ疑い等）だが、その場合も 1-RTT の
                // handshake は完了しているため副作用ゲートは開けてよい。
                let _ = hs_tx.send(true);
                if used {
                    log_line("0-rtt early data accepted");
                }
            });
            conn
        }
        Err(connecting) => {
            let conn = connecting.await?;
            let _ = hs_tx.send(true);
            conn
        }
    };
    let id = conn.stable_id();
    let remote = conn.remote_address();
    log_line(&format!("conn {id} established remote={remote}"));

    loop {
        let (send, recv) = match conn.accept_bi().await {
            Ok(pair) => pair,
            Err(e) => {
                log_line(&format!("conn {id} closed: {e}"));
                return Ok(());
            }
        };
        let token = token.clone();
        let path = injected_path.clone();
        let conn = conn.clone();
        let hs_rx = hs_rx.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_stream(conn.clone(), send, recv, token, path, hs_rx).await {
                log_line(&format!("conn {} stream error: {e:#}", conn.stable_id()));
            }
        });
    }
}

/// handshake confirmed を待つ（副作用ゲート）。送信側が落ちても現在値で判定する。
async fn wait_handshake_confirmed(rx: &mut watch::Receiver<bool>) -> bool {
    if *rx.borrow() {
        return true;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return true;
        }
    }
    *rx.borrow()
}

async fn handle_stream(
    conn: quinn::Connection,
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    token: Arc<Vec<u8>>,
    injected_path: Arc<String>,
    mut hs_rx: watch::Receiver<bool>,
) -> Result<()> {
    let header_line = match read_line(&mut recv, HEADER_CAP).await? {
        Some(line) => line,
        None => return Ok(()), // FIN before header
    };
    let header: StreamHeader = match serde_json::from_str(&header_line) {
        Ok(h) => h,
        Err(_) => return reject(&mut send, "proto").await,
    };
    if header.v != 1 {
        return reject(&mut send, "proto").await;
    }
    let presented = B64.decode(&header.token).unwrap_or_default();
    if !constant_time_eq(&presented, &token) {
        log_line(&format!("conn {} auth failure", conn.stable_id()));
        return reject(&mut send, "auth").await;
    }

    let id = conn.stable_id();
    match header.t.as_str() {
        "exec" => {
            let Some(cmd) = header.cmd.as_deref() else {
                return reject(&mut send, "proto").await;
            };
            // 0-RTT 規律: spawn は handshake confirmed 後にのみ行う。
            if !wait_handshake_confirmed(&mut hs_rx).await {
                return reject(&mut send, "proto").await;
            }
            handle_exec(id, send, recv, cmd, header.pty.as_ref(), &injected_path).await?;
        }
        "tcp" => {
            let Some(port) = header.port else {
                return reject(&mut send, "proto").await;
            };
            if !wait_handshake_confirmed(&mut hs_rx).await {
                return reject(&mut send, "proto").await;
            }
            handle_tcp(id, send, recv, port).await?;
        }
        // 診断 kind（M0 プローブ互換・副作用なしのため 0-RTT ゲート不要）
        "echo" => handle_echo(id, send, recv).await?,
        "sink" => handle_sink(id, send, recv).await?,
        "source" => handle_source(id, send, header.bytes.unwrap_or(0)).await?,
        _ => return reject(&mut send, "proto").await,
    }
    Ok(())
}

// ---------------------------------------------------------------- kind=exec

async fn handle_exec(
    conn_id: usize,
    mut send: quinn::SendStream,
    recv: quinn::RecvStream,
    cmd: &str,
    pty: Option<&PtyRequest>,
    injected_path: &str,
) -> Result<()> {
    match pty {
        Some(request) => handle_exec_pty(conn_id, send, recv, cmd, request, injected_path).await,
        None => {
            let mut child = match tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(cmd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // v1 は stderr を破棄する（現行 SSH exec も stdout へ合流させない）。
                .stderr(Stdio::null())
                .env("PATH", injected_path)
                .spawn()
            {
                Ok(child) => child,
                Err(e) => {
                    log_line(&format!("conn {conn_id} exec spawn failed: {e}"));
                    return reject(&mut send, "spawn").await;
                }
            };
            log_line(&format!(
                "conn {conn_id} exec spawn pid={} cmd={}",
                child.id().unwrap_or(0),
                truncate_for_log(cmd)
            ));
            send.write_all(b"{\"ok\":true}\n").await?;

            let mut stdin = child.stdin.take().context("child stdin missing")?;
            let mut stdout = child.stdout.take().context("child stdout missing")?;

            // クライアント→stdin。FIN で stdin を閉じて EOF を届ける。
            let mut recv = recv;
            let stdin_task = tokio::spawn(async move {
                let mut buf = vec![0u8; CHUNK];
                loop {
                    match recv.read(&mut buf).await {
                        Ok(Some(n)) => {
                            if stdin.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                        Ok(None) | Err(_) => break,
                    }
                }
                // drop(stdin) = プロセスへ EOF
            });

            // stdout→クライアント。プロセス側 EOF で FIN。
            let mut client_gone = false;
            let mut buf = vec![0u8; CHUNK];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if send.write_all(&buf[..n]).await.is_err() {
                            client_gone = true;
                            break;
                        }
                    }
                }
            }
            let _ = send.finish();
            if client_gone {
                // クライアント消失時はプロセスを残さない（SSH チャネル断と同等の扱い）。
                let _ = child.start_kill();
            }
            let status = child.wait().await;
            stdin_task.abort();
            log_line(&format!(
                "conn {conn_id} exec exit status={:?} clientGone={client_gone}",
                status.map(|s| s.code())
            ));
            Ok(())
        }
    }
}

/// PTY 付き exec（対話シェル / tmux attach 用）。
///
/// stderr は PTY に合流する（端末セマンティクス）。クライアント FIN / reset / 接続断は
/// いずれもセッション破棄として扱い、master クローズ + プロセスグループへの
/// SIGHUP → 猶予後 SIGKILL で回収する（FIN 維持だと静かな PTY が永遠に残る）。
async fn handle_exec_pty(
    conn_id: usize,
    mut send: quinn::SendStream,
    recv: quinn::RecvStream,
    cmd: &str,
    request: &PtyRequest,
    injected_path: &str,
) -> Result<()> {
    let (master, slave) = match open_pty(request.cols, request.rows) {
        Ok(pair) => pair,
        Err(e) => {
            log_line(&format!("conn {conn_id} openpty failed: {e}"));
            return reject(&mut send, "spawn").await;
        }
    };
    let slave_file = std::fs::File::from(slave);
    let term = request.term.as_deref().unwrap_or("xterm-256color");

    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(cmd)
        .stdin(Stdio::from(slave_file.try_clone()?))
        .stdout(Stdio::from(slave_file.try_clone()?))
        .stderr(Stdio::from(slave_file))
        .env("PATH", injected_path)
        .env("TERM", term);
    unsafe {
        command.pre_exec(|| {
            // 新セッションを作り、PTY slave（fd 0 に dup 済み）を制御端末にする。
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0);
            Ok(())
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            log_line(&format!("conn {conn_id} pty spawn failed: {e}"));
            return reject(&mut send, "spawn").await;
        }
    };
    log_line(&format!(
        "conn {conn_id} exec(pty {}x{}) spawn pid={} cmd={}",
        request.cols,
        request.rows,
        child.id().unwrap_or(0),
        truncate_for_log(cmd)
    ));
    send.write_all(b"{\"ok\":true}\n").await?;

    let master = Arc::new(AsyncFd::new(master)?);

    // クライアント→PTY master（キー入力）。FIN / reset / 接続断のいずれも
    // 「セッション破棄」の合図として main ループへ通知する。
    // 以前は FIN を「入力終了・セッション維持」としていたが、pty シェルへ FIN を送る
    // 正当なクライアントは存在せず（NWConnection.cancel の正常クローズが FIN になる）、
    // 出力の無い静かな PTY（例: 無操作の tmux attach / 生シェル）が誰にも回収されず
    // master fd が蓄積 → EMFILE で全 exec 不能に至った（実測 2026-07-23: 240 個）。
    let client_reset = Arc::new(tokio::sync::Notify::new());
    let reset_signal = client_reset.clone();
    let writer_master = master.clone();
    let mut recv = recv;
    let input_task = tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match recv.read(&mut buf).await {
                Ok(Some(n)) => {
                    if write_pty(&writer_master, &buf[..n]).await.is_err() {
                        break;
                    }
                }
                Ok(None) | Err(_) => {
                    reset_signal.notify_one();
                    break;
                }
            }
        }
    });

    // PTY master→クライアント。EIO / EOF は子プロセス終了（=出力終了）。
    // クライアント消失（reset）は input 側からの通知でも検知し、即時に畳む。
    let mut client_gone = false;
    let mut buf = vec![0u8; CHUNK];
    loop {
        tokio::select! {
            read = read_pty(&master, &mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if send.write_all(&buf[..n]).await.is_err() {
                        client_gone = true;
                        break;
                    }
                }
            },
            _ = client_reset.notified() => {
                client_gone = true;
                break;
            }
        }
    }
    let _ = send.finish();
    input_task.abort();

    // セッションを回収する。子は setsid でセッションリーダ = pgid==pid なので、pid を
    // pgid として **プロセスグループ全体**に SIGHUP を送る（tmux attach 等の子孫も畳む）。
    // master クローズ由来の SIGHUP は Arc の drop タイミングに依存して確実に届かないため、
    // 明示シグナルを正とする。5s 猶予後は SIGKILL でグループごと回収する。
    let pid = child.id().map(|id| id as libc::pid_t);
    drop(master);
    if let Some(pid) = pid {
        unsafe { libc::killpg(pid, libc::SIGHUP); }
    }
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep(Duration::from_secs(5)) => {
            if let Some(pid) = pid {
                unsafe { libc::killpg(pid, libc::SIGKILL); }
            }
            let _ = child.start_kill();
            child.wait().await
        }
    };
    log_line(&format!(
        "conn {conn_id} exec(pty) exit status={:?} clientGone={client_gone}",
        status.map(|s| s.code())
    ));
    Ok(())
}

fn truncate_for_log(cmd: &str) -> String {
    const MAX: usize = 120;
    if cmd.len() <= MAX {
        cmd.to_string()
    } else {
        format!("{}…", &cmd[..cmd.char_indices().take_while(|(i, _)| *i < MAX).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(0)])
    }
}

// PTY ヘルパ ---------------------------------------------------------------

fn open_pty(cols: u16, rows: u16) -> Result<(OwnedFd, OwnedFd)> {
    let mut master: libc::c_int = 0;
    let mut slave: libc::c_int = 0;
    let mut winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };
    if rc != 0 {
        bail!("openpty failed: {}", std::io::Error::last_os_error());
    }
    // master は AsyncFd で扱うため non-blocking にする。
    let flags = unsafe { libc::fcntl(master, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(master, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        bail!("fcntl O_NONBLOCK failed: {err}");
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) })
}

/// PTY master から読む。子プロセス終了後の EIO は EOF（0）として返す。
async fn read_pty(fd: &AsyncFd<OwnedFd>, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        let mut guard = fd.readable().await?;
        match guard.try_io(|inner| {
            let n = unsafe {
                libc::read(
                    inner.as_raw_fd(),
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                )
            };
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(Ok(n)) => return Ok(n),
            Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Ok(0),
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue,
        }
    }
}

async fn write_pty(fd: &AsyncFd<OwnedFd>, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        let mut guard = fd.writable().await?;
        match guard.try_io(|inner| {
            let n = unsafe {
                libc::write(
                    inner.as_raw_fd(),
                    data.as_ptr() as *const libc::c_void,
                    data.len(),
                )
            };
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(Ok(n)) => data = &data[n..],
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- kind=tcp

async fn handle_tcp(
    conn_id: usize,
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
    port: u16,
) -> Result<()> {
    // 接続先は 127.0.0.1 固定（PreviewServer はループバック限定 bind。任意ホスト転送は提供しない）。
    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(stream) => stream,
        Err(e) => {
            log_line(&format!("conn {conn_id} tcp connect 127.0.0.1:{port} failed: {e}"));
            return reject(&mut send, "connect").await;
        }
    };
    log_line(&format!("conn {conn_id} tcp connect 127.0.0.1:{port}"));
    send.write_all(b"{\"ok\":true}\n").await?;

    let (mut tcp_read, mut tcp_write) = stream.into_split();

    // クライアント→TCP。FIN で TCP 側も write half を閉じる（half-close 伝播）。
    let upstream = tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match recv.read(&mut buf).await {
                Ok(Some(n)) => {
                    if tcp_write.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = tcp_write.shutdown().await;
                    break;
                }
                Err(_) => break,
            }
        }
    });

    // TCP→クライアント。TCP EOF で FIN。
    let mut buf = vec![0u8; CHUNK];
    loop {
        match tcp_read.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if send.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = send.finish();
    upstream.await.ok();
    log_line(&format!("conn {conn_id} tcp done 127.0.0.1:{port}"));
    Ok(())
}

// ---------------------------------------------------------------- 診断 kind（M0 互換）

async fn handle_echo(
    conn_id: usize,
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
) -> Result<()> {
    send.write_all(b"{\"ok\":true}\n").await?;
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    while let Some(n) = recv.read(&mut buf).await? {
        send.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    let _ = send.finish();
    log_line(&format!("conn {conn_id} echo done bytes={total}"));
    Ok(())
}

async fn handle_sink(
    conn_id: usize,
    mut send: quinn::SendStream,
    mut recv: quinn::RecvStream,
) -> Result<()> {
    send.write_all(b"{\"ok\":true}\n").await?;
    let t0 = Instant::now();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    while let Some(n) = recv.read(&mut buf).await? {
        total += n as u64;
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let summary = format!("{{\"ok\":true,\"bytes\":{total},\"elapsedMs\":{ms:.1}}}\n");
    send.write_all(summary.as_bytes()).await?;
    let _ = send.finish();
    log_line(&format!("conn {conn_id} sink done bytes={total}"));
    Ok(())
}

async fn handle_source(conn_id: usize, mut send: quinn::SendStream, bytes: u64) -> Result<()> {
    let n = bytes.min(SOURCE_CAP);
    send.write_all(b"{\"ok\":true}\n").await?;
    let chunk = vec![0xabu8; CHUNK];
    let mut remaining = n;
    while remaining > 0 {
        let take = remaining.min(CHUNK as u64) as usize;
        send.write_all(&chunk[..take]).await?;
        remaining -= take as u64;
    }
    let _ = send.finish();
    log_line(&format!("conn {conn_id} source done bytes={n}"));
    Ok(())
}

// ---------------------------------------------------------------- クライアント（自己検証 / テスト用）

/// 証明書ピン（cert DER の SHA-256、または SPKI の SHA-256）で検証するクライアント verifier。
#[derive(Debug)]
pub struct PinVerifier {
    pub pin: [u8; 32],
    pub provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let hash: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if constant_time_eq(&hash, &self.pin) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate pin mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::PeerIncompatible(
            rustls::PeerIncompatible::Tls12NotOffered,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// ピン検証つきのクライアント endpoint を作る（自己検証 / 統合テスト用）。
pub fn make_client_endpoint(cert_pin: [u8; 32]) -> Result<quinn::Endpoint> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut crypto = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier {
            pin: cert_pin,
            provider,
        }))
        .with_no_client_auth();
    crypto.alpn_protocols = vec![ALPN.to_vec()];

    let mut client_config = quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(crypto)?));
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(Some(IDLE_TIMEOUT.try_into()?));
    transport.keep_alive_interval(Some(KEEPALIVE));
    client_config.transport_config(Arc::new(transport));

    let mut endpoint = quinn::Endpoint::client(SocketAddr::from(([0, 0, 0, 0], 0)))?;
    endpoint.set_default_client_config(client_config);
    Ok(endpoint)
}

/// serve 中のゲートウェイに対する自己検証（exec / exec+pty / tcp / 認証拒否）。
/// `tailii doctor` や手動検証から `tailii-quic-gw client --pin <cert sha256> --token <b64>` で使う。
pub async fn run_selfcheck(host: &str, port: u16, cert_pin_b64: &str, token_b64: &str) -> Result<()> {
    let pin: [u8; 32] = B64
        .decode(cert_pin_b64)?
        .try_into()
        .map_err(|_| anyhow!("pin must be 32 bytes"))?;
    let endpoint = make_client_endpoint(pin)?;
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let t0 = Instant::now();
    let conn = endpoint.connect(addr, "tailii")?.await?;
    println!("connected in {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0);

    // 1) exec: cat エコー + FIN 伝播
    {
        let (mut send, mut recv) = conn.open_bi().await?;
        let header =
            format!("{{\"t\":\"exec\",\"v\":1,\"token\":\"{token_b64}\",\"cmd\":\"cat\"}}\n");
        send.write_all(header.as_bytes()).await?;
        let ok = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("no exec header response")?;
        anyhow::ensure!(ok.contains("\"ok\":true"), "exec rejected: {ok}");
        send.write_all(b"exec-echo\n").await?;
        let back = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("exec stream ended early")?;
        anyhow::ensure!(back == "exec-echo", "exec echo mismatch: {back}");
        send.finish()?;
        let fin = read_line(&mut recv, HEADER_CAP).await?;
        anyhow::ensure!(fin.is_none(), "expected FIN after stdin EOF, got: {fin:?}");
        println!("exec (cat) echo + FIN: ok");
    }

    // 2) exec + pty
    {
        let (mut send, mut recv) = conn.open_bi().await?;
        let header = format!(
            "{{\"t\":\"exec\",\"v\":1,\"token\":\"{token_b64}\",\"cmd\":\"printf 'pty-ok\\\\n'\",\"pty\":{{\"cols\":80,\"rows\":24}}}}\n"
        );
        send.write_all(header.as_bytes()).await?;
        let ok = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("no pty header response")?;
        anyhow::ensure!(ok.contains("\"ok\":true"), "pty exec rejected: {ok}");
        let mut out = Vec::new();
        let mut buf = vec![0u8; CHUNK];
        while let Some(n) = recv.read(&mut buf).await? {
            out.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8_lossy(&out);
        anyhow::ensure!(text.contains("pty-ok"), "pty output missing marker: {text:?}");
        println!("exec (pty): ok");
    }

    // 3) tcp: ループバックのエコーサーバへ配管
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let tcp_port = listener.local_addr()?.port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 1024];
                if let Ok(n) = socket.read(&mut buf).await {
                    let _ = socket.write_all(&buf[..n]).await;
                }
            }
        });
        let (mut send, mut recv) = conn.open_bi().await?;
        let header =
            format!("{{\"t\":\"tcp\",\"v\":1,\"token\":\"{token_b64}\",\"port\":{tcp_port}}}\n");
        send.write_all(header.as_bytes()).await?;
        let ok = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("no tcp header response")?;
        anyhow::ensure!(ok.contains("\"ok\":true"), "tcp rejected: {ok}");
        send.write_all(b"tcp-echo\n").await?;
        let back = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("tcp stream ended early")?;
        anyhow::ensure!(back == "tcp-echo", "tcp echo mismatch: {back}");
        send.finish()?;
        println!("tcp pipe: ok");
    }

    // 4) 誤トークンの拒否
    {
        let (mut send, mut recv) = conn.open_bi().await?;
        send.write_all(b"{\"t\":\"exec\",\"v\":1,\"token\":\"AAAA\",\"cmd\":\"true\"}\n")
            .await?;
        let rejected = read_line(&mut recv, HEADER_CAP)
            .await?
            .context("no rejection response")?;
        anyhow::ensure!(
            rejected.contains("\"err\":\"auth\""),
            "expected auth rejection: {rejected}"
        );
        println!("auth rejection: ok");
    }

    conn.close(0u32.into(), b"done");
    endpoint.wait_idle().await;
    println!("all selfchecks passed");
    Ok(())
}

// ---------------------------------------------------------------- unit tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn header_parses_exec_with_pty() {
        let line = r#"{"t":"exec","v":1,"token":"dG9r","cmd":"tailii-host engine","pty":{"cols":80,"rows":24,"term":"xterm-256color"}}"#;
        let header: StreamHeader = serde_json::from_str(line).unwrap();
        assert_eq!(header.t, "exec");
        assert_eq!(header.v, 1);
        assert_eq!(header.cmd.as_deref(), Some("tailii-host engine"));
        let pty = header.pty.unwrap();
        assert_eq!((pty.cols, pty.rows), (80, 24));
        assert_eq!(pty.term.as_deref(), Some("xterm-256color"));
    }

    #[test]
    fn header_parses_tcp() {
        let line = r#"{"t":"tcp","v":1,"token":"dG9r","port":49152}"#;
        let header: StreamHeader = serde_json::from_str(line).unwrap();
        assert_eq!(header.t, "tcp");
        assert_eq!(header.port, Some(49152));
        assert!(header.cmd.is_none());
        assert!(header.pty.is_none());
    }

    #[test]
    fn header_rejects_garbage() {
        assert!(serde_json::from_str::<StreamHeader>("not json").is_err());
        assert!(serde_json::from_str::<StreamHeader>(r#"{"t":"exec"}"#).is_err());
    }

    #[test]
    fn injected_path_matches_launch_ts_order() {
        std::env::set_var("HOME", "/Users/test");
        let path = default_injected_path();
        assert_eq!(
            path,
            "/opt/homebrew/bin:/Users/test/.local/bin:/Users/test/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
    }

    #[test]
    fn credentials_are_idempotent() {
        let dir = std::env::temp_dir().join(format!("quicgw-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = load_or_create_credentials(&dir).unwrap();
        let second = load_or_create_credentials(&dir).unwrap();
        assert_eq!(first.spki_pin(), second.spki_pin());
        assert_eq!(first.cert_pin(), second.cert_pin());
        assert_eq!(first.token_b64(), second.token_b64());
        assert_eq!(first.token.len(), 32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_for_log_handles_long_multibyte() {
        let long = "あ".repeat(100);
        let truncated = truncate_for_log(&long);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() < long.len());
        assert_eq!(truncate_for_log("short"), "short");
    }
}
