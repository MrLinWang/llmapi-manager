use crate::desktop_config::DesktopPaths;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const HEALTH_URL: &str = "http://127.0.0.1:8787/api/health";

/// Owns the bundled Node process. Dropping the sidecar kills the process tree
/// so a crashed/closed desktop app does not leave port 8787 occupied.
pub struct Sidecar {
    child: Child,
    pid: u32,
    stopped: bool,
}

impl Sidecar {
    pub fn start(
        paths: &DesktopPaths,
        runtime: &Path,
        lan_access: bool,
        setup_needed: bool,
    ) -> Result<(Self, Option<String>), String> {
        let node = runtime.join("node.exe");
        let entry = runtime.join("server").join("dist").join("index.js");
        if !node.is_file() {
            return Err(format!("便携包缺少 Node 运行时：{}", node.display()));
        }
        if !entry.is_file() {
            return Err(format!("便携包缺少服务入口：{}", entry.display()));
        }

        fs::create_dir_all(&paths.data)
            .map_err(|error| format!("无法创建数据目录 {}: {error}", paths.data.display()))?;
        fs::create_dir_all(&paths.log)
            .map_err(|error| format!("无法创建日志目录 {}: {error}", paths.log.display()))?;
        let log_path = paths.log.join("desktop-server.log");
        let token = Arc::new(Mutex::new(None::<String>));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        let mut command = Command::new(&node);
        command
            .arg(&entry)
            .current_dir(runtime)
            .env("HOST", if lan_access { "0.0.0.0" } else { "127.0.0.1" })
            .env("PORT", "8787")
            .env("PUBLIC_BASE_URL", "http://127.0.0.1:8787")
            .env("DATA_DIR", &paths.data)
            .env("LOG_DIR", &paths.log)
            .env("NODE_ENV", "production")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Ok(home) = std::env::var("USERPROFILE") {
            command.env("AGENT_HOME_DIR", home);
        }
        if let Some(key) = paths.encryption_key() {
            command.env("DATA_ENCRYPTION_KEY", key);
        }
        if let Some(codex) = find_codex_bin() {
            command.env("CODEX_BIN", codex);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: never flash a console window.
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动本地服务：{error}"))?;
        let pid = child.id();

        if let Some(stdout) = child.stdout.take() {
            let token = Arc::clone(&token);
            let log_path = log_path.clone();
            thread::spawn(move || read_stream(stdout, &log_path, Some(token), None));
        }
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            let log_path = log_path.clone();
            thread::spawn(move || read_stream(stderr, &log_path, None, Some(tail)));
        }

        if !wait_for_health(Duration::from_secs(30)) {
            let detail = stderr_tail.lock().map(|tail| tail.clone()).unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
            return Err(if detail.trim().is_empty() {
                "本地服务未能在 30 秒内启动（/api/health 无响应）。".to_string()
            } else {
                format!("本地服务未能启动：\n{}", detail.trim())
            });
        }

        let mut captured = None;
        if setup_needed {
            for _ in 0..15 {
                if let Some(value) = token.lock().ok().and_then(|guard| guard.clone()) {
                    captured = Some(value);
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
            if captured.is_none() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "服务已启动，但没有捕获到初始化令牌。请删除 data/setup.json 后重试。"
                        .to_string(),
                );
            }
        }

        Ok((Self { child, pid, stopped: false }, captured))
    }

    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        #[cfg(windows)]
        {
            let pid = self.pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", &pid, "/T", "/F"])
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Read a child stream line by line. stdout lines are scanned for the one-time
/// setup token; both streams are appended to the desktop log so a failed start
/// can be diagnosed without a console window.
fn read_stream<R: std::io::Read + Send + 'static>(
    stream: R,
    log_path: &Path,
    token: Option<Arc<Mutex<Option<String>>>>,
    tail: Option<Arc<Mutex<String>>>,
) {
    let reader = BufReader::new(stream);
    for line in reader.lines().map_while(Result::ok) {
        append_line(log_path, &line);
        if let Some(token) = token.as_ref() {
            if let Some(value) = parse_setup_token(&line) {
                if let Ok(mut guard) = token.lock() {
                    *guard = Some(value);
                }
            }
        }
        if let Some(tail) = tail.as_ref() {
            if let Ok(mut guard) = tail.lock() {
                guard.push_str(&line);
                guard.push('\n');
                if guard.len() > 6000 {
                    let split = guard.len().saturating_sub(4000);
                    *guard = guard.split_off(split);
                }
            }
        }
    }
}

fn append_line(path: &Path, line: &str) {
    let _ = fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn parse_setup_token(line: &str) -> Option<String> {
    let start = line.find("setup_")?;
    let token: String = line[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();
    if token.len() > 12 {
        Some(token)
    } else {
        None
    }
}

fn wait_for_health(timeout: Duration) -> bool {
    let attempts = timeout.as_millis() / 500;
    for _ in 0..attempts {
        if let Ok(response) = ureq::get(HEALTH_URL)
            .timeout(Duration::from_secs(2))
            .call()
        {
            if response.status() == 200 {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn find_codex_bin() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CODEX_BIN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let candidates = [
        std::env::var("APPDATA").ok().map(|base| PathBuf::from(base).join("npm").join("codex.cmd")),
        std::env::var("USERPROFILE")
            .ok()
            .map(|base| PathBuf::from(base).join("AppData").join("Roaming").join("npm").join("codex.cmd")),
    ];
    candidates.into_iter().flatten().find(|path| path.is_file())
}
