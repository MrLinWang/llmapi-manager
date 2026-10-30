use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Non-secret desktop preferences. Stored next to the app data.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesktopSettings {
    #[serde(default)]
    pub lan_access: bool,
}

impl DesktopSettings {
    pub fn read(paths: &DesktopPaths) -> Self {
        let file = paths.root.join("desktop.json");
        fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn write(&self, paths: &DesktopPaths) -> Result<(), String> {
        let file = paths.root.join("desktop.json");
        let temp = paths.root.join("desktop.json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        fs::write(&temp, text).map_err(|error| error.to_string())?;
        fs::rename(&temp, &file).map_err(|error| error.to_string())
    }
}

/// All mutable paths used by the desktop shell.
///
/// The Node sidecar is intentionally given absolute paths instead of relying on
/// the server's `.env` loader: the installed app directory is read-only and the
/// user may run several builds side by side.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    pub root: PathBuf,
    pub data: PathBuf,
    pub log: PathBuf,
}

impl DesktopPaths {
    pub fn new() -> Result<Self, String> {
        let base = env::var("APPDATA")
            .or_else(|_| env::var("HOME").map(|home| format!("{home}/.config")))
            .unwrap_or_else(|_| ".".to_string());
        let root = PathBuf::from(base).join("llmapi-manager");
        let data = root.join("data");
        let log = root.join("log");
        // Only the root is created here. The sidecar creates data/log on start;
        // keeping `data` absent until then lets the legacy migration script tell
        // "never started" from "already has desktop data" and copy safely.
        fs::create_dir_all(&root).map_err(|error| format!("无法创建 {}: {error}", root.display()))?;
        Ok(Self { root, data, log })
    }

    pub fn setup_file(&self) -> PathBuf {
        self.data.join("setup.json")
    }

    pub fn identity_file(&self) -> PathBuf {
        self.data.join("identity.json")
    }

    pub fn encryption_key_file(&self) -> PathBuf {
        self.root.join("desktop.env")
    }

    /// Reads `DATA_ENCRYPTION_KEY` from desktop.env without pulling in a dotenv
    /// parser. Only one key is stored in this file.
    pub fn encryption_key(&self) -> Option<String> {
        let text = fs::read_to_string(self.encryption_key_file()).ok()?;
        for line in text.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("DATA_ENCRYPTION_KEY=") {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    /// Generates a key only for a fresh data directory. If old data exists and
    /// the key is missing, do not create a new key: encrypted values from the
    /// old machine would become undecryptable.
    pub fn ensure_encryption_key(&self) -> Result<Option<String>, String> {
        if let Some(key) = self.encryption_key() {
            return Ok(Some(key));
        }
        if !directory_is_empty(&self.data) {
            return Ok(None);
        }

        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let key = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let file = self.encryption_key_file();
        let text = format!("DATA_ENCRYPTION_KEY={key}\r\n");
        let temp = self.root.join("desktop.env.tmp");
        fs::write(&temp, text).map_err(|error| error.to_string())?;
        restrict_file(&temp);
        fs::rename(&temp, &file).map_err(|error| error.to_string())?;
        restrict_file(&file);
        Ok(Some(key))
    }

    /// True when the default tenant has at least one user.
    pub fn has_users(&self) -> bool {
        let Ok(text) = fs::read_to_string(self.identity_file()) else {
            return false;
        };
        let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
            return false;
        };
        root.get("data")
            .and_then(|data| data.get("users"))
            .and_then(|users| users.as_array())
            .map(|users| !users.is_empty())
            .unwrap_or(false)
    }

    /// The server only prints the setup token once. If setup was interrupted,
    /// there is no console to read the old token from, so rotate `setup.json`
    /// before spawning the sidecar. This is safe only while there is no user.
    pub fn rotate_setup_token(&self) -> Result<(), String> {
        if self.has_users() {
            return Ok(());
        }
        let setup = self.setup_file();
        if !setup.exists() {
            return Ok(());
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let backup = self.data.join(format!("setup.json.bak-{stamp}"));
        fs::rename(&setup, &backup)
            .map_err(|error| format!("无法重置初始化状态 {}: {error}", setup.display()))?;
        Ok(())
    }

    /// Old Windows service data is kept in `%ProgramData%`. The installer/
    /// migration script copies it; if it is still present and the desktop data
    /// directory is empty, point the user at the migration helper instead of
    /// silently starting with a blank configuration.
    pub fn legacy_migration_source(&self) -> Option<PathBuf> {
        if !directory_is_empty(&self.data) {
            return None;
        }
        let program_data = env::var("PROGRAMDATA").ok()?;
        let source = PathBuf::from(program_data).join("llmapi-manager").join("data");
        if source.is_dir() {
            Some(source)
        } else {
            None
        }
    }
}

fn directory_is_empty(path: &Path) -> bool {
    let Ok(mut entries) = fs::read_dir(path) else {
        return true;
    };
    entries.next().is_none()
}

#[cfg(windows)]
fn restrict_file(path: &Path) {
    let user = env::var("USERNAME").unwrap_or_default();
    let domain = env::var("USERDOMAIN").unwrap_or_default();
    if user.is_empty() {
        return;
    }
    let account = if domain.is_empty() {
        user
    } else {
        format!("{domain}\\{user}")
    };
    let grant = format!("{account}:F");
    let _ = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(grant)
        .arg("*S-1-5-18:F")
        .status();
}

#[cfg(not(windows))]
fn restrict_file(_path: &Path) {}
