// Tauri desktop shell for Osama.
//
// On launch the Rust side starts the *same* Node engine (`server/dist/index.js`)
// as a child process, waits for its /api/health endpoint, and then hands the
// window over to the built UI. This keeps one implementation of the engine for
// browser and desktop, and means the UI talks to the engine over plain HTTP.
//
// Build:  npm run build            (core + server + ui)
// Dev:    npm run tauri dev        (starts the UI dev server + this shell)
// Bundle: npm run tauri build      (requires Rust + platform webview deps)

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

const ENGINE_PORT: u16 = 5178;
const ENGINE_HOST: &str = "127.0.0.1";

struct EngineProcess(Mutex<Option<Child>>);

/// Best-effort path to the app's data dir, so the engine keeps its state in the
/// OS-appropriate location when launched from the bundle.
fn app_data_dir() -> Option<std::path::PathBuf> {
    directories::ProjectDirs::from("at", "kmail", "Osama").map(|d| d.data_dir().to_path_buf())
}

fn port_open(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    match addr.parse() {
        Ok(sock) => TcpStream::connect_timeout(&sock, Duration::from_millis(250)).is_ok(),
        Err(_) => false,
    }
}

/// Locate `server/dist/index.js` both in development and inside the bundle.
fn engine_entry(app: &tauri::App) -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // Bundled alongside the executable (bundle.resources).
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("engine/index.js"));
    }
    // Development: repo layout.
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("server/dist/index.js"));
        candidates.push(cwd.join("../server/dist/index.js"));
    }
    candidates.into_iter().find(|p| p.exists())
}

fn start_engine(app: &tauri::App) -> Option<Child> {
    if port_open(ENGINE_HOST, ENGINE_PORT) {
        // An engine is already running (e.g. `npm run dev`), reuse it.
        return None;
    }
    let entry = engine_entry(app)?;
    let mut cmd = Command::new("node");
    cmd.arg(entry)
        .env("OSAMA_HOST", ENGINE_HOST)
        .env("OSAMA_PORT", ENGINE_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(dir) = app_data_dir() {
        cmd.env("OSAMA_HOME", dir);
    }
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("osama: could not start the engine: {err}");
            None
        }
    }
}

fn wait_for_engine(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_open(ENGINE_HOST, ENGINE_PORT) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let child = start_engine(app);
            app.manage(EngineProcess(Mutex::new(child)));
            if !wait_for_engine(Duration::from_secs(20)) {
                eprintln!("osama: engine did not become ready within 20s");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<EngineProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Osama");
}
