#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    window::Color,
    Emitter, LogicalPosition, LogicalSize, Manager,
};

const TRAY_TOGGLE_ID: &str = "toggle-window";
const TRAY_FLOAT_ID: &str = "toggle-floating-window";
const TRAY_QUIT_ID: &str = "quit";
const WINDOW_SHOWN_EVENT: &str = "main-window-shown";
const WINDOW_FOCUSED_EVENT: &str = "main-window-focused";
const DB_FILE_NAME: &str = "worknote.sqlite";
const BACKUP_DIR_NAME: &str = "backup";
const NORMAL_WIDTH: f64 = 480.0;
const NORMAL_HEIGHT: f64 = 680.0;
const NORMAL_MIN_WIDTH: f64 = 420.0;
const NORMAL_MIN_HEIGHT: f64 = 560.0;
const FLOAT_WIDTH: f64 = 360.0;
const FLOAT_HEIGHT: f64 = 620.0;
const FLOAT_MIN_WIDTH: f64 = 320.0;
const FLOAT_MIN_HEIGHT: f64 = 520.0;
const FLOAT_EDGE_MARGIN: i32 = 12;
const EDGE_COLLAPSED_WIDTH: f64 = 60.0;
const EDGE_COLLAPSED_HEIGHT: f64 = 64.0;
const EDGE_COLLAPSED_MIN_WIDTH: f64 = 52.0;
const EDGE_COLLAPSED_MIN_HEIGHT: f64 = 56.0;

#[derive(Clone, Copy)]
enum EdgeSide {
    Left,
    Right,
}

impl EdgeSide {
    fn as_str(self) -> &'static str {
        match self {
            EdgeSide::Left => "left",
            EdgeSide::Right => "right",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EdgeWindowInfo {
    edge_side: String,
    edge_tab_y: f64,
}

struct LogicalWorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[derive(Clone)]
struct DbState {
    db_path: PathBuf,
    backup_dir: PathBuf,
}

struct WindowModeState {
    is_floating: Mutex<bool>,
}

struct BackupState {
    lock: Mutex<()>,
}

struct UiLanguageState {
    toggle: MenuItem<tauri::Wry>,
    floating: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    tray: TrayIcon<tauri::Wry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    status: String,
    #[serde(default = "default_task_priority")]
    priority: String,
    #[serde(default)]
    is_prioritized: bool,
    created_at: String,
    completed_at: Option<String>,
    project_name: Option<String>,
    planned_date: Option<String>,
    sort_order: i64,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DailySummary {
    id: String,
    date: String,
    completed_count: i64,
    carried_count: i64,
    note: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    total: usize,
    imported: usize,
    skipped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataInfo {
    database_path: String,
    task_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    file_path: String,
    task_count: usize,
    summary_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupResult {
    backup_dir: String,
    file_path: Option<String>,
    created: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPayload {
    tasks: Vec<Task>,
    daily_summaries: Vec<DailySummary>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowModeInfo {
    mode: String,
    is_floating: bool,
}

fn default_task_priority() -> String {
    "normal".to_string()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join(DB_FILE_NAME);
            let backup_dir = app_data_dir.join(BACKUP_DIR_NAME);
            init_database(&db_path)?;
            fs::create_dir_all(&backup_dir)?;
            app.manage(DbState {
                db_path,
                backup_dir,
            });
            app.manage(WindowModeState {
                is_floating: Mutex::new(false),
            });
            app.manage(BackupState {
                lock: Mutex::new(()),
            });

            let toggle = MenuItem::with_id(
                app,
                TRAY_TOGGLE_ID,
                "显示/隐藏 Worknote",
                true,
                None::<&str>,
            )?;
            let floating =
                MenuItem::with_id(app, TRAY_FLOAT_ID, "切换窗口模式", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &floating, &quit])?;
            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Worknote")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_TOGGLE_ID => toggle_main_window(app),
                    TRAY_FLOAT_ID => {
                        if let Ok(info) = toggle_window_mode_for_app(app) {
                            let _ = app.emit("window-mode-changed", info);
                        }
                    }
                    TRAY_QUIT_ID => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.manage(UiLanguageState {
                toggle,
                floating,
                quit,
                tray,
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::Focused(true) => {
                        let _ = window.app_handle().emit(WINDOW_FOCUSED_EVENT, ());
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks,
            create_task,
            update_task_details,
            update_task_prioritized,
            update_task_status,
            delete_task,
            clear_done_tasks,
            import_tasks,
            get_data_info,
            export_tasks_json,
            ensure_daily_backup,
            move_task_to_date,
            move_task_to_inbox,
            restore_task_to_schedule,
            get_daily_summary,
            close_day,
            get_recent_summaries,
            get_window_mode,
            set_window_mode,
            toggle_window_mode,
            collapse_edge_window,
            expand_edge_window,
            focus_edge_window,
            move_edge_tab,
            set_app_language
        ])
        .build(tauri::generate_context!())
        .expect("error while building worknote")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
        });
}

#[tauri::command]
fn set_app_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, UiLanguageState>,
    language: String,
) -> Result<(), String> {
    let is_english = language == "en";
    let toggle_label = if is_english {
        "Show/Hide Worknote"
    } else {
        "显示/隐藏 Worknote"
    };
    let floating_label = if is_english {
        "Switch window mode"
    } else {
        "切换窗口模式"
    };
    let quit_label = if is_english { "Quit" } else { "退出" };

    state
        .toggle
        .set_text(toggle_label)
        .map_err(|error| error.to_string())?;
    state
        .floating
        .set_text(floating_label)
        .map_err(|error| error.to_string())?;
    state
        .quit
        .set_text(quit_label)
        .map_err(|error| error.to_string())?;
    state
        .tray
        .set_tooltip(Some("Worknote"))
        .map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_title("Worknote")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit(WINDOW_SHOWN_EVENT, ());
    }
}

fn window_mode_info(is_floating: bool) -> WindowModeInfo {
    WindowModeInfo {
        mode: if is_floating { "floating" } else { "normal" }.to_string(),
        is_floating,
    }
}

fn apply_window_mode(
    window: &tauri::WebviewWindow,
    is_floating: bool,
) -> Result<WindowModeInfo, String> {
    if is_floating {
        set_window_panel_background(window)?;
        let _ = window.set_shadow(true);
        window
            .set_decorations(true)
            .map_err(|error| format!("恢复浮窗窗口装饰失败：{error}"))?;
        window
            .set_min_size(Some(LogicalSize::new(FLOAT_MIN_WIDTH, FLOAT_MIN_HEIGHT)))
            .map_err(|error| format!("设置浮窗最小尺寸失败：{error}"))?;
        window
            .set_size(LogicalSize::new(FLOAT_WIDTH, FLOAT_HEIGHT))
            .map_err(|error| format!("设置浮窗尺寸失败：{error}"))?;
        window
            .set_always_on_top(true)
            .map_err(|error| format!("设置浮窗置顶失败：{error}"))?;
        position_floating_window(window)?;
    } else {
        set_window_panel_background(window)?;
        let _ = window.set_shadow(true);
        window
            .set_decorations(true)
            .map_err(|error| format!("恢复普通窗口装饰失败：{error}"))?;
        window
            .set_always_on_top(false)
            .map_err(|error| format!("取消浮窗置顶失败：{error}"))?;
        window
            .set_min_size(Some(LogicalSize::new(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT)))
            .map_err(|error| format!("恢复普通模式最小尺寸失败：{error}"))?;
        window
            .set_size(LogicalSize::new(NORMAL_WIDTH, NORMAL_HEIGHT))
            .map_err(|error| format!("恢复普通模式尺寸失败：{error}"))?;
        position_window_within_work_area(window, NORMAL_WIDTH, NORMAL_HEIGHT)?;
    }

    let _ = window.show();
    let _ = window.set_focus();
    Ok(window_mode_info(is_floating))
}

fn set_window_transparent_background(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|error| format!("设置透明窗口背景失败：{error}"))
}

fn set_window_panel_background(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(Color(255, 253, 248, 255)))
        .map_err(|error| format!("恢复窗口面板背景失败：{error}"))
}

fn position_window_within_work_area(
    window: &tauri::WebviewWindow,
    logical_window_width: f64,
    logical_window_height: f64,
) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("读取当前显示器失败：{error}"))?
        .or(window
            .primary_monitor()
            .map_err(|error| format!("读取主显示器失败：{error}"))?);

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        let logical_x = work_area.position.x as f64 / scale_factor;
        let logical_y = work_area.position.y as f64 / scale_factor;
        let logical_width = work_area.size.width as f64 / scale_factor;
        let logical_height = work_area.size.height as f64 / scale_factor;
        let edge_margin = f64::from(FLOAT_EDGE_MARGIN);
        let current_position = window
            .outer_position()
            .map_err(|error| format!("读取窗口位置失败：{error}"))?;
        let current_x = current_position.x as f64 / scale_factor;
        let current_y = current_position.y as f64 / scale_factor;
        let min_x = logical_x + edge_margin;
        let min_y = logical_y + edge_margin;
        let max_x = logical_x + logical_width - logical_window_width - edge_margin;
        let max_y = logical_y + logical_height - logical_window_height - edge_margin;
        let x = current_x.clamp(min_x, max_x.max(min_x));
        let y = current_y.clamp(min_y, max_y.max(min_y));

        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| format!("恢复窗口可见位置失败：{error}"))?;
    }

    Ok(())
}

fn position_floating_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let Some(area) = logical_work_area(window)? else {
        return Ok(());
    };

    let edge_margin = f64::from(FLOAT_EDGE_MARGIN);
    let x = area.x + area.width - FLOAT_WIDTH - edge_margin;
    let y = area.y + ((area.height - FLOAT_HEIGHT) / 2.0).max(edge_margin);

    window
        .set_position(LogicalPosition::new(x.max(area.x), y.max(area.y)))
        .map_err(|error| format!("贴近屏幕右侧失败：{error}"))?;

    Ok(())
}

fn logical_work_area(window: &tauri::WebviewWindow) -> Result<Option<LogicalWorkArea>, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("读取当前显示器失败：{error}"))?
        .or(window
            .primary_monitor()
            .map_err(|error| format!("读取主显示器失败：{error}"))?);

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        return Ok(Some(LogicalWorkArea {
            x: work_area.position.x as f64 / scale_factor,
            y: work_area.position.y as f64 / scale_factor,
            width: work_area.size.width as f64 / scale_factor,
            height: work_area.size.height as f64 / scale_factor,
            scale_factor,
        }));
    }

    Ok(None)
}

fn current_logical_position(
    window: &tauri::WebviewWindow,
    area: &LogicalWorkArea,
) -> Result<(f64, f64), String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("读取窗口位置失败：{error}"))?;

    Ok((
        position.x as f64 / area.scale_factor,
        position.y as f64 / area.scale_factor,
    ))
}

fn current_logical_size(
    window: &tauri::WebviewWindow,
    area: &LogicalWorkArea,
) -> Result<(f64, f64), String> {
    let size = window
        .outer_size()
        .map_err(|error| format!("读取窗口尺寸失败：{error}"))?;

    Ok((
        size.width as f64 / area.scale_factor,
        size.height as f64 / area.scale_factor,
    ))
}

fn clamp_edge_tab_y(area: &LogicalWorkArea, y: f64) -> f64 {
    let edge_margin = f64::from(FLOAT_EDGE_MARGIN);
    let min_y = area.y + edge_margin;
    let max_y = area.y + area.height - EDGE_COLLAPSED_HEIGHT - edge_margin;
    y.clamp(min_y, max_y.max(min_y))
}

fn clamp_floating_y(area: &LogicalWorkArea, y: f64) -> f64 {
    let edge_margin = f64::from(FLOAT_EDGE_MARGIN);
    let min_y = area.y + edge_margin;
    let max_y = area.y + area.height - FLOAT_HEIGHT - edge_margin;
    y.clamp(min_y, max_y.max(min_y))
}

fn edge_side_from_center(area: &LogicalWorkArea, center_x: f64) -> EdgeSide {
    if center_x < area.x + area.width / 2.0 {
        EdgeSide::Left
    } else {
        EdgeSide::Right
    }
}

fn edge_x_for_side(area: &LogicalWorkArea, side: EdgeSide) -> f64 {
    match side {
        EdgeSide::Left => area.x,
        EdgeSide::Right => area.x + area.width - EDGE_COLLAPSED_WIDTH,
    }
}

fn floating_x_for_side(area: &LogicalWorkArea, side: EdgeSide) -> f64 {
    let edge_margin = f64::from(FLOAT_EDGE_MARGIN);
    match side {
        EdgeSide::Left => area.x + edge_margin,
        EdgeSide::Right => area.x + area.width - FLOAT_WIDTH - edge_margin,
    }
}

fn edge_info(side: EdgeSide, y: f64) -> EdgeWindowInfo {
    EdgeWindowInfo {
        edge_side: side.as_str().to_string(),
        edge_tab_y: y,
    }
}

fn ensure_floating_mode(state: tauri::State<'_, WindowModeState>) -> Result<(), String> {
    let current = state
        .is_floating
        .lock()
        .map_err(|_| "窗口模式状态锁定失败。".to_string())?;
    if *current {
        Ok(())
    } else {
        Err("边缘吸附只在浮窗模式下可用。".to_string())
    }
}

#[tauri::command]
fn collapse_edge_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowModeState>,
    edge_tab_y: Option<f64>,
) -> Result<EdgeWindowInfo, String> {
    ensure_floating_mode(state)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在。".to_string())?;
    let area = logical_work_area(&window)?.ok_or_else(|| "没有可用显示器。".to_string())?;
    let (current_x, current_y) = current_logical_position(&window, &area)?;
    let (current_width, _) = current_logical_size(&window, &area)?;
    let side = edge_side_from_center(&area, current_x + current_width / 2.0);
    let y = clamp_edge_tab_y(&area, edge_tab_y.unwrap_or(current_y));

    set_window_transparent_background(&window)?;
    let _ = window.set_shadow(false);
    window
        .set_decorations(false)
        .map_err(|error| format!("隐藏收起浮窗窗口装饰失败：{error}"))?;
    window
        .set_min_size(Some(LogicalSize::new(
            EDGE_COLLAPSED_MIN_WIDTH,
            EDGE_COLLAPSED_MIN_HEIGHT,
        )))
        .map_err(|error| format!("设置收起浮窗最小尺寸失败：{error}"))?;
    window
        .set_size(LogicalSize::new(
            EDGE_COLLAPSED_WIDTH,
            EDGE_COLLAPSED_HEIGHT,
        ))
        .map_err(|error| format!("设置收起浮窗尺寸失败：{error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("保持收起浮窗置顶失败：{error}"))?;
    window
        .set_position(LogicalPosition::new(edge_x_for_side(&area, side), y))
        .map_err(|error| format!("收起浮窗贴边失败：{error}"))?;
    let _ = window.show();
    Ok(edge_info(side, y))
}

#[tauri::command]
fn expand_edge_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowModeState>,
    edge_side: Option<String>,
    edge_tab_y: Option<f64>,
) -> Result<EdgeWindowInfo, String> {
    ensure_floating_mode(state)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在。".to_string())?;
    let area = logical_work_area(&window)?.ok_or_else(|| "没有可用显示器。".to_string())?;
    let (current_x, current_y) = current_logical_position(&window, &area)?;
    let (current_width, _) = current_logical_size(&window, &area)?;
    let inferred_side = edge_side_from_center(&area, current_x + current_width / 2.0);
    let side = match edge_side.as_deref() {
        Some("left") => EdgeSide::Left,
        Some("right") => EdgeSide::Right,
        _ => inferred_side,
    };
    let tab_y = clamp_edge_tab_y(&area, edge_tab_y.unwrap_or(current_y));
    let y = clamp_floating_y(&area, tab_y);

    set_window_panel_background(&window)?;
    let _ = window.set_shadow(true);
    window
        .set_decorations(true)
        .map_err(|error| format!("恢复浮窗窗口装饰失败：{error}"))?;
    window
        .set_min_size(Some(LogicalSize::new(FLOAT_MIN_WIDTH, FLOAT_MIN_HEIGHT)))
        .map_err(|error| format!("恢复浮窗最小尺寸失败：{error}"))?;
    window
        .set_size(LogicalSize::new(FLOAT_WIDTH, FLOAT_HEIGHT))
        .map_err(|error| format!("恢复浮窗尺寸失败：{error}"))?;
    window
        .set_always_on_top(true)
        .map_err(|error| format!("恢复浮窗置顶失败：{error}"))?;
    window
        .set_position(LogicalPosition::new(floating_x_for_side(&area, side), y))
        .map_err(|error| format!("展开浮窗贴边失败：{error}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(edge_info(side, tab_y))
}

#[tauri::command]
fn focus_edge_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowModeState>,
) -> Result<(), String> {
    ensure_floating_mode(state)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在。".to_string())?;

    let _ = window.show();
    let _ = window.set_always_on_top(true);
    window
        .set_focus()
        .map_err(|error| format!("聚焦收起浮窗失败：{error}"))
}

#[tauri::command]
fn move_edge_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowModeState>,
    screen_x: f64,
    screen_y: f64,
    grab_offset_x: f64,
    grab_offset_y: f64,
    is_final: bool,
) -> Result<EdgeWindowInfo, String> {
    ensure_floating_mode(state)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在。".to_string())?;
    let area = logical_work_area(&window)?.ok_or_else(|| "没有可用显示器。".to_string())?;
    let min_x = area.x;
    let max_x = area.x + area.width - EDGE_COLLAPSED_WIDTH;
    let next_x = (screen_x - grab_offset_x).clamp(min_x, max_x.max(min_x));
    let next_y = clamp_edge_tab_y(&area, screen_y - grab_offset_y);
    let side = edge_side_from_center(&area, next_x + EDGE_COLLAPSED_WIDTH / 2.0);
    let snapped_x = if is_final {
        edge_x_for_side(&area, side)
    } else {
        next_x
    };

    window
        .set_position(LogicalPosition::new(snapped_x, next_y))
        .map_err(|error| format!("移动收起浮窗失败：{error}"))?;

    Ok(edge_info(side, next_y))
}

fn set_window_mode_for_app(
    app: &tauri::AppHandle,
    is_floating: bool,
) -> Result<WindowModeInfo, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在。".to_string())?;
    let was_visible = window.is_visible().unwrap_or(false);
    let info = apply_window_mode(&window, is_floating)?;
    let mode_state = app.state::<WindowModeState>();
    let mut current = mode_state
        .is_floating
        .lock()
        .map_err(|_| "窗口模式状态锁定失败。".to_string())?;
    *current = is_floating;
    if !was_visible {
        let _ = app.emit(WINDOW_SHOWN_EVENT, ());
    }
    Ok(info)
}

fn toggle_window_mode_for_app(app: &tauri::AppHandle) -> Result<WindowModeInfo, String> {
    let mode_state = app.state::<WindowModeState>();
    let current = mode_state
        .is_floating
        .lock()
        .map_err(|_| "窗口模式状态锁定失败。".to_string())?;
    let next_mode = !*current;
    drop(current);
    set_window_mode_for_app(app, next_mode)
}

#[tauri::command]
fn set_window_mode(app: tauri::AppHandle, mode: String) -> Result<WindowModeInfo, String> {
    let is_floating = mode == "floating";
    let info = set_window_mode_for_app(&app, is_floating)?;
    let _ = app.emit("window-mode-changed", info.clone());
    Ok(info)
}

#[tauri::command]
fn toggle_window_mode(app: tauri::AppHandle) -> Result<WindowModeInfo, String> {
    let info = toggle_window_mode_for_app(&app)?;
    let _ = app.emit("window-mode-changed", info.clone());
    Ok(info)
}

#[tauri::command]
fn get_window_mode(state: tauri::State<'_, WindowModeState>) -> Result<WindowModeInfo, String> {
    let current = state
        .is_floating
        .lock()
        .map_err(|_| "窗口模式状态锁定失败。".to_string())?;
    Ok(window_mode_info(*current))
}

fn init_database(db_path: &Path) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            is_prioritized INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            project_name TEXT,
            planned_date TEXT,
            sort_order INTEGER DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order);

        CREATE TABLE IF NOT EXISTS daily_summaries (
            id TEXT PRIMARY KEY,
            date TEXT NOT NULL UNIQUE,
            completed_count INTEGER NOT NULL DEFAULT 0,
            carried_count INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
        ",
    )?;
    ensure_tasks_column(&conn, "planned_date", "TEXT")?;
    ensure_tasks_column(&conn, "sort_order", "INTEGER DEFAULT 0")?;
    ensure_tasks_column(&conn, "updated_at", "TEXT")?;
    ensure_tasks_column(&conn, "priority", "TEXT NOT NULL DEFAULT 'normal'")?;
    ensure_tasks_column(&conn, "is_prioritized", "INTEGER NOT NULL DEFAULT 0")?;

    Ok(())
}

fn ensure_tasks_column(
    conn: &Connection,
    column_name: &str,
    column_type: &str,
) -> Result<(), Box<dyn Error>> {
    let mut stmt = conn.prepare("PRAGMA table_info(tasks)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(());
        }
    }

    conn.execute(
        &format!("ALTER TABLE tasks ADD COLUMN {column_name} {column_type}"),
        [],
    )?;
    Ok(())
}

fn connect(state: &DbState) -> Result<Connection, String> {
    Connection::open(&state.db_path).map_err(|error| format!("打开 SQLite 数据库失败：{error}"))
}

fn normalize_task(mut task: Task) -> Result<Task, String> {
    task.title = task.title.trim().to_string();
    if task.id.trim().is_empty() {
        return Err("任务 id 不能为空。".to_string());
    }
    if task.title.is_empty() {
        return Err("任务内容不能为空。".to_string());
    }
    if task.status != "todo" && task.status != "done" {
        task.status = "todo".to_string();
        task.completed_at = None;
    }
    if task.status == "todo" {
        task.completed_at = None;
    }
    task.priority = normalize_task_priority_value(task.priority);
    if task.created_at.trim().is_empty() {
        return Err("任务创建时间不能为空。".to_string());
    }
    if task.updated_at.trim().is_empty() {
        task.updated_at = task.created_at.clone();
    }

    Ok(task)
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        status: row.get(2)?,
        priority: row.get(3)?,
        is_prioritized: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
        completed_at: row.get(6)?,
        project_name: row.get(7)?,
        planned_date: row.get(8)?,
        sort_order: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn normalize_task_priority_value(priority: String) -> String {
    match priority.as_str() {
        "urgent_important" | "urgent" | "important" | "normal" => priority,
        _ => "normal".to_string(),
    }
}

fn load_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
                id,
                title,
                status,
                COALESCE(priority, 'normal'),
                COALESCE(is_prioritized, 0),
                created_at,
                completed_at,
                project_name,
                planned_date,
                COALESCE(sort_order, 0),
                COALESCE(updated_at, created_at)
            FROM tasks
            ORDER BY
                COALESCE(is_prioritized, 0) DESC,
                CASE COALESCE(priority, 'normal')
                    WHEN 'urgent_important' THEN 0
                    WHEN 'urgent' THEN 1
                    WHEN 'important' THEN 2
                    ELSE 3
                END ASC,
                created_at ASC,
                id ASC
            ",
        )
        .map_err(|error| format!("读取任务失败：{error}"))?;

    let rows = stmt
        .query_map([], row_to_task)
        .map_err(|error| format!("读取任务失败：{error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取任务失败：{error}"))
}

fn load_task(conn: &Connection, id: &str) -> Result<Option<Task>, String> {
    conn.query_row(
        "
        SELECT
            id,
            title,
            status,
            COALESCE(priority, 'normal'),
            COALESCE(is_prioritized, 0),
            created_at,
            completed_at,
            project_name,
            planned_date,
            COALESCE(sort_order, 0),
            COALESCE(updated_at, created_at)
        FROM tasks
        WHERE id = ?1
        ",
        [id],
        row_to_task,
    )
    .optional()
    .map_err(|error| format!("读取任务失败：{error}"))
}

fn insert_task(conn: &Connection, task: &Task, ignore_existing: bool) -> Result<usize, String> {
    let sql = if ignore_existing {
        "
        INSERT OR IGNORE INTO tasks (
            id, title, status, priority, is_prioritized, created_at, completed_at, project_name, planned_date, sort_order, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "
    } else {
        "
        INSERT INTO tasks (
            id, title, status, priority, is_prioritized, created_at, completed_at, project_name, planned_date, sort_order, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "
    };

    conn.execute(
        sql,
        params![
            &task.id,
            &task.title,
            &task.status,
            &task.priority,
            task.is_prioritized,
            &task.created_at,
            &task.completed_at,
            &task.project_name,
            &task.planned_date,
            task.sort_order,
            &task.updated_at
        ],
    )
    .map_err(|error| format!("保存任务失败：{error}"))
}

fn row_to_daily_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<DailySummary> {
    Ok(DailySummary {
        id: row.get(0)?,
        date: row.get(1)?,
        completed_count: row.get(2)?,
        carried_count: row.get(3)?,
        note: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn load_daily_summary(conn: &Connection, date: &str) -> Result<Option<DailySummary>, String> {
    conn.query_row(
        "
        SELECT id, date, completed_count, carried_count, note, created_at, updated_at
        FROM daily_summaries
        WHERE date = ?1
        ",
        [date],
        row_to_daily_summary,
    )
    .optional()
    .map_err(|error| format!("读取历史摘要失败：{error}"))
}

fn load_recent_daily_summaries(conn: &Connection, limit: i64) -> Result<Vec<DailySummary>, String> {
    let safe_limit = limit.clamp(1, 30);
    let mut stmt = conn
        .prepare(
            "
            SELECT id, date, completed_count, carried_count, note, created_at, updated_at
            FROM daily_summaries
            ORDER BY date DESC
            LIMIT ?1
            ",
        )
        .map_err(|error| format!("读取最近记录失败：{error}"))?;

    let rows = stmt
        .query_map([safe_limit], row_to_daily_summary)
        .map_err(|error| format!("读取最近记录失败：{error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取最近记录失败：{error}"))
}

fn load_all_daily_summaries(conn: &Connection) -> Result<Vec<DailySummary>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT id, date, completed_count, carried_count, note, created_at, updated_at
            FROM daily_summaries
            ORDER BY date DESC
            ",
        )
        .map_err(|error| format!("读取历史摘要失败：{error}"))?;

    let rows = stmt
        .query_map([], row_to_daily_summary)
        .map_err(|error| format!("读取历史摘要失败：{error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取历史摘要失败：{error}"))
}

fn current_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取当前时间失败：{error}"))
        .map(|duration| duration.as_secs())
}

fn current_epoch_nanos() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取当前时间失败：{error}"))
        .map(|duration| duration.as_nanos())
}

fn is_valid_date_string(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }

    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }

    let year = match value[0..4].parse::<i32>() {
        Ok(year) => year,
        Err(_) => return false,
    };
    let month = match value[5..7].parse::<u32>() {
        Ok(month) => month,
        Err(_) => return false,
    };
    let day = match value[8..10].parse::<u32>() {
        Ok(day) => day,
        Err(_) => return false,
    };

    if month == 0 || month > 12 || day == 0 {
        return false;
    }

    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };

    day <= max_day
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn is_valid_backup_json(file_path: &Path) -> bool {
    let json = match fs::read_to_string(file_path) {
        Ok(json) => json,
        Err(_) => return false,
    };
    let value = match serde_json::from_str::<serde_json::Value>(&json) {
        Ok(value) => value,
        Err(_) => return false,
    };

    value
        .get("tasks")
        .and_then(|tasks| tasks.as_array())
        .is_some()
        && value
            .get("dailySummaries")
            .and_then(|summaries| summaries.as_array())
            .is_some()
}

fn write_json_atomic(file_path: &Path, json: &str) -> Result<(), String> {
    let parent = file_path
        .parent()
        .ok_or_else(|| "写入 JSON 文件失败：文件路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 JSON 目录失败：{error}"))?;

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "写入 JSON 文件失败：文件名无效。".to_string())?;
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", current_epoch_nanos()?));

    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("创建临时 JSON 文件失败：{error}"))?;
        file.write_all(json.as_bytes())
            .map_err(|error| format!("写入临时 JSON 文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步临时 JSON 文件失败：{error}"))?;
        drop(file);
        fs::rename(&temp_path, file_path)
            .map_err(|error| format!("保存 JSON 文件失败：{error}"))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn write_export_payload(
    file_path: &Path,
    tasks: Vec<Task>,
    daily_summaries: Vec<DailySummary>,
) -> Result<(usize, usize), String> {
    let task_count = tasks.len();
    let summary_count = daily_summaries.len();
    let payload = ExportPayload {
        tasks,
        daily_summaries,
    };
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("生成 JSON 失败：{error}"))?;
    write_json_atomic(file_path, &json)?;
    Ok((task_count, summary_count))
}

fn create_daily_backup_if_needed(
    db_path: &Path,
    backup_dir: &Path,
    backup_date: String,
) -> Result<BackupResult, String> {
    let backup_date = backup_date.trim();
    if !is_valid_date_string(backup_date) {
        return Err("每日备份日期参数无效。".to_string());
    }

    let timestamp = current_epoch_seconds()?;
    fs::create_dir_all(backup_dir).map_err(|error| format!("创建每日备份目录失败：{error}"))?;

    let backup_prefix = format!("worknote-daily-backup-{backup_date}-");
    let has_current_backup = fs::read_dir(backup_dir)
        .map_err(|error| format!("读取每日备份目录失败：{error}"))?
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| {
                    name.starts_with(&backup_prefix)
                        && name.ends_with(".json")
                        && is_valid_backup_json(&entry.path())
                })
                .unwrap_or(false)
        });

    if has_current_backup {
        return Ok(BackupResult {
            backup_dir: backup_dir.display().to_string(),
            file_path: None,
            created: false,
        });
    }

    let conn =
        Connection::open(db_path).map_err(|error| format!("打开 SQLite 数据库失败：{error}"))?;
    let tasks = load_tasks(&conn)?;
    let daily_summaries = load_all_daily_summaries(&conn)?;
    let file_path = backup_dir.join(format!("{backup_prefix}{timestamp}.json"));
    write_export_payload(&file_path, tasks, daily_summaries)?;

    Ok(BackupResult {
        backup_dir: backup_dir.display().to_string(),
        file_path: Some(file_path.display().to_string()),
        created: true,
    })
}

#[tauri::command]
fn get_tasks(state: tauri::State<'_, DbState>) -> Result<Vec<Task>, String> {
    let conn = connect(&state)?;
    load_tasks(&conn)
}

#[tauri::command]
fn create_task(state: tauri::State<'_, DbState>, task: Task) -> Result<Task, String> {
    let task = normalize_task(task)?;
    let conn = connect(&state)?;
    insert_task(&conn, &task, false)?;
    Ok(task)
}

#[tauri::command]
fn update_task_details(
    state: tauri::State<'_, DbState>,
    id: String,
    title: String,
    priority: String,
    updated_at: String,
) -> Result<Task, String> {
    let next_title = title.trim().to_string();
    if next_title.is_empty() {
        return Err("任务内容不能为空。".to_string());
    }

    let next_priority = normalize_task_priority_value(priority);

    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET title = ?2, priority = ?3, updated_at = ?4
            WHERE id = ?1
            ",
            params![id, next_title, next_priority, updated_at],
        )
        .map_err(|error| format!("修改任务失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn update_task_prioritized(
    state: tauri::State<'_, DbState>,
    id: String,
    is_prioritized: bool,
    updated_at: String,
) -> Result<Task, String> {
    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET is_prioritized = ?2, updated_at = ?3
            WHERE id = ?1
            ",
            params![id, is_prioritized, updated_at],
        )
        .map_err(|error| format!("更新任务优先状态失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn update_task_status(
    state: tauri::State<'_, DbState>,
    id: String,
    status: String,
    completed_at: Option<String>,
    updated_at: String,
) -> Result<Task, String> {
    let next_status = if status == "done" { "done" } else { "todo" };
    let next_completed_at = if next_status == "done" {
        completed_at
    } else {
        None
    };

    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET status = ?2, completed_at = ?3, updated_at = ?4
            WHERE id = ?1
            ",
            params![id, next_status, next_completed_at, updated_at],
        )
        .map_err(|error| format!("更新任务失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn delete_task(state: tauri::State<'_, DbState>, id: String) -> Result<usize, String> {
    let conn = connect(&state)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|error| format!("删除任务失败：{error}"))
}

#[tauri::command]
fn clear_done_tasks(state: tauri::State<'_, DbState>, date: String) -> Result<usize, String> {
    let date = date.trim();
    if !is_valid_date_string(date) {
        return Err("清空已完成日期参数无效。".to_string());
    }

    let conn = connect(&state)?;
    conn.execute(
        "
        DELETE FROM tasks
        WHERE status = 'done'
          AND (
            substr(completed_at, 1, 10) = ?1
            OR (TRIM(COALESCE(completed_at, '')) = '' AND planned_date = ?1)
          )
        ",
        [date],
    )
    .map_err(|error| format!("清空已完成任务失败：{error}"))
}

#[tauri::command]
fn move_task_to_date(
    state: tauri::State<'_, DbState>,
    task_id: String,
    planned_date: String,
    updated_at: String,
) -> Result<Task, String> {
    if planned_date.trim().is_empty() {
        return Err("计划日期不能为空。".to_string());
    }

    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET planned_date = ?2, updated_at = ?3
            WHERE id = ?1
            ",
            params![task_id, planned_date, updated_at],
        )
        .map_err(|error| format!("移动任务失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &task_id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn move_task_to_inbox(
    state: tauri::State<'_, DbState>,
    task_id: String,
    updated_at: String,
) -> Result<Task, String> {
    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET planned_date = NULL, updated_at = ?2
            WHERE id = ?1
            ",
            params![task_id, updated_at],
        )
        .map_err(|error| format!("移动任务失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &task_id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn restore_task_to_schedule(
    state: tauri::State<'_, DbState>,
    task_id: String,
    planned_date: Option<String>,
    updated_at: String,
) -> Result<Task, String> {
    let next_planned_date = planned_date.and_then(|date| {
        let trimmed = date.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let conn = connect(&state)?;
    let changed = conn
        .execute(
            "
            UPDATE tasks
            SET status = 'todo', completed_at = NULL, planned_date = ?2, updated_at = ?3
            WHERE id = ?1
            ",
            params![task_id, next_planned_date, updated_at],
        )
        .map_err(|error| format!("恢复任务失败：{error}"))?;

    if changed == 0 {
        return Err("任务不存在，可能已被删除。".to_string());
    }

    load_task(&conn, &task_id)?.ok_or_else(|| "任务不存在，可能已被删除。".to_string())
}

#[tauri::command]
fn import_tasks(
    state: tauri::State<'_, DbState>,
    tasks: Vec<Task>,
) -> Result<ImportResult, String> {
    let mut conn = connect(&state)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("导入旧任务失败：{error}"))?;

    let total = tasks.len();
    let mut imported = 0usize;
    let mut skipped = 0usize;

    for task in tasks {
        match normalize_task(task).and_then(|task| insert_task(&tx, &task, true)) {
            Ok(1) => imported += 1,
            Ok(_) => skipped += 1,
            Err(error) => {
                tx.rollback().map_err(|rollback_error| {
                    format!("导入旧任务失败：{error}；回滚失败：{rollback_error}")
                })?;
                return Err(error);
            }
        }
    }

    tx.commit()
        .map_err(|error| format!("导入旧任务失败：{error}"))?;

    Ok(ImportResult {
        total,
        imported,
        skipped,
    })
}

#[tauri::command]
fn get_daily_summary(
    state: tauri::State<'_, DbState>,
    date: String,
) -> Result<Option<DailySummary>, String> {
    let conn = connect(&state)?;
    load_daily_summary(&conn, &date)
}

#[tauri::command]
fn close_day(
    state: tauri::State<'_, DbState>,
    date: String,
    tomorrow_date: String,
    timestamp: String,
) -> Result<DailySummary, String> {
    if date.trim().is_empty() || tomorrow_date.trim().is_empty() || timestamp.trim().is_empty() {
        return Err("收工日期参数不能为空。".to_string());
    }

    let mut conn = connect(&state)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("今日收工失败：{error}"))?;

    let completed_count = tx
        .query_row(
            "
            SELECT COUNT(*)
            FROM tasks
            WHERE status = 'done'
              AND (
                substr(completed_at, 1, 10) = ?1
                OR (TRIM(COALESCE(completed_at, '')) = '' AND planned_date = ?1)
              )
            ",
            [&date],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("统计今日完成任务失败：{error}"))?;

    let carried_count =
        tx.execute(
            "
            UPDATE tasks
            SET planned_date = ?2, updated_at = ?3
            WHERE status != 'done'
              AND planned_date = ?1
            ",
            params![&date, &tomorrow_date, &timestamp],
        )
        .map_err(|error| format!("延后今日未完成任务失败：{error}"))? as i64;

    let id = format!("daily-summary-{date}");
    tx.execute(
        "
        INSERT INTO daily_summaries (
            id, date, completed_count, carried_count, note, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
        ON CONFLICT(date) DO UPDATE SET
            completed_count = excluded.completed_count,
            carried_count = excluded.carried_count,
            note = excluded.note,
            updated_at = excluded.updated_at
        ",
        params![&id, &date, completed_count, carried_count, &timestamp],
    )
    .map_err(|error| format!("保存历史摘要失败：{error}"))?;

    tx.commit()
        .map_err(|error| format!("今日收工失败：{error}"))?;

    let conn = connect(&state)?;
    load_daily_summary(&conn, &date)?.ok_or_else(|| "历史摘要保存后读取失败。".to_string())
}

#[tauri::command]
fn get_recent_summaries(
    state: tauri::State<'_, DbState>,
    limit: i64,
) -> Result<Vec<DailySummary>, String> {
    let conn = connect(&state)?;
    load_recent_daily_summaries(&conn, limit)
}

#[tauri::command]
fn get_data_info(state: tauri::State<'_, DbState>) -> Result<DataInfo, String> {
    let conn = connect(&state)?;
    let task_count = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .map_err(|error| format!("读取数据状态失败：{error}"))?;

    Ok(DataInfo {
        database_path: state.db_path.display().to_string(),
        task_count,
    })
}

#[tauri::command]
fn ensure_daily_backup(
    state: tauri::State<'_, DbState>,
    backup_state: tauri::State<'_, BackupState>,
    backup_date: String,
) -> Result<BackupResult, String> {
    let _guard = backup_state
        .lock
        .lock()
        .map_err(|_| "每日备份锁异常，请重启工作日志。".to_string())?;
    create_daily_backup_if_needed(&state.db_path, &state.backup_dir, backup_date)
}

#[tauri::command]
fn export_tasks_json(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<ExportResult, String> {
    let conn = connect(&state)?;
    let tasks = load_tasks(&conn)?;
    let daily_summaries = load_all_daily_summaries(&conn)?;
    let export_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("读取应用数据目录失败：{error}"))?
        .join("exports");
    fs::create_dir_all(&export_dir).map_err(|error| format!("创建导出目录失败：{error}"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("生成导出文件名失败：{error}"))?
        .as_secs();
    let file_path = export_dir.join(format!("worknote-tasks-{timestamp}.json"));
    let (task_count, summary_count) = write_export_payload(&file_path, tasks, daily_summaries)?;

    Ok(ExportResult {
        file_path: file_path.display().to_string(),
        task_count,
        summary_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_with_priority(priority: &str) -> Task {
        Task {
            id: "task-1".to_string(),
            title: "测试任务".to_string(),
            status: "todo".to_string(),
            priority: priority.to_string(),
            is_prioritized: false,
            created_at: "2026-09-15T10:00:00.000+08:00".to_string(),
            completed_at: None,
            project_name: None,
            planned_date: Some("2026-09-15".to_string()),
            sort_order: 0,
            updated_at: "2026-09-15T10:00:00.000+08:00".to_string(),
        }
    }

    #[test]
    fn supports_combined_task_priority_and_normalizes_unknown_values() {
        let combined = normalize_task(task_with_priority("urgent_important"))
            .expect("combined priority should be valid");
        assert_eq!(combined.priority, "urgent_important");

        let unknown = normalize_task(task_with_priority("unexpected"))
            .expect("unknown priority should fall back safely");
        assert_eq!(unknown.priority, "normal");
    }

    #[test]
    fn migrates_prioritized_column_and_orders_oldest_last_added_within_weight() {
        let dir = std::env::temp_dir().join(format!(
            "worknote-priority-order-test-{}",
            current_epoch_nanos().expect("test clock should be readable")
        ));
        fs::create_dir_all(&dir).expect("test temp dir should be created");
        let db_path = dir.join("worknote.sqlite");

        {
            let conn = Connection::open(&db_path).expect("legacy database should open");
            conn.execute_batch(
                "
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL DEFAULT 'normal',
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    project_name TEXT,
                    planned_date TEXT,
                    sort_order INTEGER DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                ",
            )
            .expect("legacy tasks table should be created");
        }

        init_database(&db_path).expect("database migration should succeed");
        let conn = Connection::open(&db_path).expect("migrated database should open");
        let has_prioritized_column = conn
            .prepare("PRAGMA table_info(tasks)")
            .expect("table info should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("table info should load")
            .filter_map(Result::ok)
            .any(|column| column == "is_prioritized");
        assert!(has_prioritized_column);

        let fixtures = [
            (
                "normal-prioritized",
                "normal",
                true,
                "2026-09-15T11:00:00.000Z",
            ),
            (
                "combined",
                "urgent_important",
                false,
                "2026-09-15T10:00:00.000Z",
            ),
            ("urgent-old", "urgent", false, "2026-09-15T08:00:00.000Z"),
            ("urgent-new", "urgent", false, "2026-09-15T09:00:00.000Z"),
            ("important", "important", false, "2026-09-15T07:00:00.000Z"),
            ("normal", "normal", false, "2026-09-15T06:00:00.000Z"),
        ];

        for (id, priority, is_prioritized, created_at) in fixtures {
            let mut task = task_with_priority(priority);
            task.id = id.to_string();
            task.is_prioritized = is_prioritized;
            task.created_at = created_at.to_string();
            task.updated_at = created_at.to_string();
            insert_task(&conn, &task, false).expect("fixture task should be inserted");
        }

        let ordered_ids: Vec<String> = load_tasks(&conn)
            .expect("tasks should load")
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(
            ordered_ids,
            vec![
                "normal-prioritized",
                "combined",
                "urgent-old",
                "urgent-new",
                "important",
                "normal",
            ]
        );

        drop(conn);
        let _ = fs::remove_file(&db_path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn validates_backup_dates_strictly() {
        assert!(is_valid_date_string("2026-06-09"));
        assert!(is_valid_date_string("2024-02-29"));
        assert!(!is_valid_date_string("2026-6-9"));
        assert!(!is_valid_date_string("2026-02-29"));
        assert!(!is_valid_date_string("2026-13-01"));
        assert!(!is_valid_date_string("../2026-06-09"));
    }

    #[test]
    fn writes_json_atomically_without_leaving_temp_file() {
        let dir = std::env::temp_dir().join(format!(
            "worknote-json-write-test-{}",
            current_epoch_nanos().expect("test clock should be readable")
        ));
        fs::create_dir_all(&dir).expect("test temp dir should be created");
        let file_path = dir.join("payload.json");

        write_json_atomic(&file_path, r#"{"tasks":[],"dailySummaries":[]}"#)
            .expect("json should be written");

        let saved = fs::read_to_string(&file_path).expect("json should be readable");
        assert_eq!(saved, r#"{"tasks":[],"dailySummaries":[]}"#);
        let has_temp_file = fs::read_dir(&dir)
            .expect("test temp dir should be readable")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.ends_with(".tmp"))
                    .unwrap_or(false)
            });
        assert!(!has_temp_file);

        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn writes_daily_backup_to_the_supplied_app_data_directory() {
        let dir = std::env::temp_dir().join(format!(
            "worknote-backup-location-test-{}",
            current_epoch_nanos().expect("test clock should be readable")
        ));
        let db_path = dir.join("worknote.sqlite");
        let backup_dir = dir.join("backup");
        fs::create_dir_all(&dir).expect("test temp dir should be created");
        init_database(&db_path).expect("test database should initialize");

        let result = create_daily_backup_if_needed(&db_path, &backup_dir, "2026-09-15".to_string())
            .expect("daily backup should be created");
        let file_path = result.file_path.expect("backup should have a file path");

        assert_eq!(result.backup_dir, backup_dir.display().to_string());
        assert!(Path::new(&file_path).starts_with(&backup_dir));
        assert!(Path::new(&file_path).is_file());

        let _ = fs::remove_dir_all(&dir);
    }
}
