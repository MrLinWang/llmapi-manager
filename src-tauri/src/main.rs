#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_config;
mod sidecar;

use desktop_config::{DesktopPaths, DesktopSettings};
use sidecar::Sidecar;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};

const ADDRESS: &str = "http://127.0.0.1:8787";

struct AppState {
    paths: DesktopPaths,
    settings: Mutex<DesktopSettings>,
    server: Mutex<Option<Sidecar>>,
    lan_item: Mutex<Option<CheckMenuItem<Wry>>>,
    quitting: AtomicBool,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            setup_app(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let state = window.state::<Arc<AppState>>();
                    if state.quitting.load(Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build LLM API Manager")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<Arc<AppState>>();
                if let Ok(mut guard) = state.server.lock() {
                    if let Some(mut server) = guard.take() {
                        server.stop();
                    }
                };
            }
        });
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let paths = DesktopPaths::new().map_err(io_error)?;
    let settings = DesktopSettings::read(&paths);
    // Do not create a fresh key while old service data is waiting to be migrated:
    // that would make the old encrypted provider keys undecryptable.
    if paths.legacy_migration_source().is_none() {
        let _ = paths.ensure_encryption_key();
    }

    let state = Arc::new(AppState {
        paths,
        settings: Mutex::new(settings.clone()),
        server: Mutex::new(None),
        lan_item: Mutex::new(None),
        quitting: AtomicBool::new(false),
    });
    app.manage(Arc::clone(&state));

    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let lan = CheckMenuItem::with_id(
        app,
        "lan",
        "允许局域网访问（同步）",
        true,
        settings.lan_access,
        None::<&str>,
    )?;
    let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &lan, &separator, &data, &logs, &quit])?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let _tray = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    *state.lan_item.lock().map_err(poisoned)? = Some(lan);

    let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:5173".parse()?)
    } else {
        WebviewUrl::App("index.html".into())
    };
    let window = WebviewWindowBuilder::new(app, "main", url)
        .title("LLM API Manager")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .visible(false)
        .build()?;

    if cfg!(debug_assertions) {
        window.show()?;
        window.set_focus()?;
    } else {
        spawn_server(app.handle().clone(), state);
    }
    Ok(())
}

fn spawn_server(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        if let Some(source) = state.paths.legacy_migration_source() {
            show_error(
                &app,
                format!(
                    "检测到旧版 Windows 服务数据：{}\n\n请先以管理员身份运行 scripts\\windows\\migrate-from-service.ps1，迁移完成后重新启动应用。",
                    source.display()
                ),
            );
            return;
        }

        let lan = match state.settings.lock() {
            Ok(settings) => settings.lan_access,
            Err(_) => {
                show_error(&app, "桌面配置已损坏，请删除 desktop.json 后重试。".to_string());
                return;
            }
        };
        let setup_needed = !state.paths.has_users();
        if setup_needed {
            if let Err(error) = state.paths.rotate_setup_token() {
                show_error(&app, error);
                return;
            }
        }

        let runtime = resolve_runtime(&app);
        match Sidecar::start(&state.paths, &runtime, lan, setup_needed) {
            Ok((server, token)) => {
                if let Ok(mut guard) = state.server.lock() {
                    *guard = Some(server);
                }
                let url = match token {
                    Some(token) if setup_needed => format!("{ADDRESS}/setup#token={token}"),
                    _ => format!("{ADDRESS}/"),
                };
                navigate(&app, url);
            }
            Err(error) => show_error(&app, error),
        }
    });
}

fn handle_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Arc<AppState>>();
    match id {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "data" => open_path(&state.paths.data),
        "logs" => open_path(&state.paths.log),
        "quit" => {
            state.quitting.store(true, Ordering::SeqCst);
            if let Ok(mut guard) = state.server.lock() {
                if let Some(mut server) = guard.take() {
                    server.stop();
                }
            }
            app.exit(0);
        }
        "lan" => toggle_lan(app, state),
        _ => {}
    }
}

fn toggle_lan(app: &AppHandle, state: tauri::State<'_, Arc<AppState>>) {
    if !state.paths.has_users() {
        show_error(app, "请先完成初始化，再开启局域网访问。".to_string());
        return;
    }
    let next = {
        let mut settings = match state.settings.lock() {
            Ok(settings) => settings,
            Err(_) => return,
        };
        settings.lan_access = !settings.lan_access;
        let next = settings.lan_access;
        if let Err(error) = settings.write(&state.paths) {
            show_error(app, format!("保存网络设置失败：{error}"));
            return;
        }
        if let Ok(item) = state.lan_item.lock() {
            if let Some(item) = item.as_ref() {
                let _ = item.set_checked(next);
            }
        }
        next
    };

    if let Ok(mut guard) = state.server.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
    let app = app.clone();
    let state = Arc::clone(&state);
    std::thread::spawn(move || {
        let runtime = resolve_runtime(&app);
        match Sidecar::start(&state.paths, &runtime, next, false) {
            Ok((server, _)) => {
                if let Ok(mut guard) = state.server.lock() {
                    *guard = Some(server);
                }
                navigate(&app, format!("{ADDRESS}/"));
            }
            Err(error) => show_error(&app, error),
        }
    });
}

fn navigate(app: &AppHandle, url: String) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let script = format!(
                "window.location.replace({})",
                serde_json::to_string(&url).unwrap_or_else(|_| "\"/\"".to_string())
            );
            let _ = window.eval(&script);
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

fn show_error(app: &AppHandle, message: String) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let script = format!(
                "if (typeof window.showError === 'function') {{ window.showError({msg}); }} else {{ window.alert({msg}); }}",
                msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"启动失败\"".to_string())
            );
            let _ = window.eval(&script);
            let _ = window.show();
        }
    });
}

fn resolve_runtime(app: &AppHandle) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let mut candidates = vec![exe_dir.join("runtime")];
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("runtime"));
        candidates.push(resource.join("resources").join("runtime"));
    }
    candidates.push(exe_dir.join("resources").join("runtime"));
    candidates
        .into_iter()
        .find(|path| path.is_dir())
        .unwrap_or_else(|| exe_dir.join("runtime"))
}

fn open_path(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg(path).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("xdg-open").arg(path).spawn();
    }
}

fn io_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, message))
}

fn poisoned<T>(_error: T) -> Box<dyn std::error::Error> {
    io_error("桌面状态锁已损坏".to_string())
}
