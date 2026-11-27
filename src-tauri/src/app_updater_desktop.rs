use crate::desktop::launch_in_system;
use skill_library::app_updater::{
    format_install_error, resolve_updater_config, validate_release_url, AppUpdateCheckResult,
    AppUpdateDownloadProgress, AppUpdateInfo, AppUpdateRelease, ResolvedUpdaterConfig,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdaterPluginConfig {
    #[serde(default)]
    endpoints: Vec<String>,
    #[serde(default)]
    pubkey: String,
}

#[derive(Default)]
pub(crate) struct AppUpdaterState {
    inner: Mutex<UpdaterSlot>,
    next_download_id: AtomicU64,
}

#[derive(Default)]
struct UpdaterSlot {
    pending: Option<PendingUpdate>,
    active_download: Option<ActiveDownload>,
}

struct PendingUpdate {
    update: Update,
    downloaded_bytes: Option<Vec<u8>>,
}

struct ActiveDownload {
    id: u64,
    cancelled: Arc<AtomicBool>,
    abort_fn: Box<dyn FnOnce() + Send + Sync>,
}

fn resolve_runtime_config(app: &tauri::AppHandle) -> Result<ResolvedUpdaterConfig, String> {
    let raw_plugin = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| serde_json::from_value::<UpdaterPluginConfig>(value.clone()).ok())
        .unwrap_or_default();
    let env_endpoint = std::env::var("SKILL_LIBRARY_UPDATE_ENDPOINT").ok();
    let env_pubkey = std::env::var("SKILL_LIBRARY_UPDATE_PUBKEY").ok();
    resolve_updater_config(
        &raw_plugin.endpoints,
        &raw_plugin.pubkey,
        env_endpoint.as_deref(),
        env_pubkey.as_deref(),
    )
}

#[tauri::command]
pub(crate) fn app_update_info(app: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let resolved = resolve_runtime_config(&app)?;
    Ok(AppUpdateInfo {
        current_version,
        configured: resolved.configured,
        releases_url: resolved.releases_url,
    })
}

#[tauri::command]
pub(crate) async fn check_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppUpdaterState>,
) -> Result<AppUpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let resolved = resolve_runtime_config(&app)?;
    if !resolved.configured {
        if let Ok(mut slot) = state.inner.lock() {
            if slot.active_download.is_none() {
                slot.pending = None;
            }
        }
        return Ok(AppUpdateCheckResult::Unconfigured {
            current_version,
            releases_url: resolved.releases_url,
        });
    }

    let updater = app
        .updater_builder()
        .pubkey(&resolved.pubkey)
        .endpoints(resolved.endpoints)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;

    let found = updater.check().await.map_err(|error| error.to_string())?;
    let mut slot = state.inner.lock().map_err(|_| unavailable())?;
    if slot.active_download.is_some() {
        return Err("正在下载更新，请稍后再检查。".to_owned());
    }

    match found {
        None => {
            slot.pending = None;
            Ok(AppUpdateCheckResult::UpToDate {
                current_version,
                releases_url: resolved.releases_url,
            })
        }
        Some(update) => {
            let published_at = update.date.map(|date| {
                format!(
                    "{:04}-{:02}-{:02}",
                    date.year(),
                    u8::from(date.month()),
                    date.day()
                )
            });
            let release = AppUpdateRelease {
                version: update.version.clone(),
                published_at,
                notes: update.body.clone(),
                releases_url: resolved.releases_url.clone(),
            };
            let cached_bytes = slot
                .pending
                .as_mut()
                .filter(|existing| existing.update.version == update.version)
                .and_then(|existing| existing.downloaded_bytes.take());
            slot.pending = Some(PendingUpdate {
                update,
                downloaded_bytes: cached_bytes,
            });
            Ok(AppUpdateCheckResult::Available {
                current_version,
                release,
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn download_app_update(
    state: State<'_, AppUpdaterState>,
    version: String,
    progress: Channel<AppUpdateDownloadProgress>,
) -> Result<(), String> {
    let download_id = state.next_download_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancelled = Arc::new(AtomicBool::new(false));
    let update = {
        let slot = state.inner.lock().map_err(|_| unavailable())?;
        if slot.active_download.is_some() {
            return Err("当前已有应用更新正在下载。".to_owned());
        }
        let pending = slot
            .pending
            .as_ref()
            .filter(|pending| pending.update.version == version)
            .ok_or_else(|| "未找到该版本的更新信息，请重新检查更新。".to_owned())?;
        pending.update.clone()
    };

    let progress_for_task = progress.clone();
    let cancelled_for_task = cancelled.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut started = false;
        let state_totals = Arc::new(Mutex::new((0_u64, None::<u64>)));
        let chunk_totals = state_totals.clone();
        let finish_totals = state_totals.clone();
        let finish_progress = progress_for_task.clone();
        let finish_cancelled = cancelled_for_task.clone();
        let result = update
            .download(
                move |chunk_length, content_length| {
                    if cancelled_for_task.load(Ordering::SeqCst) {
                        return;
                    }
                    if !started {
                        started = true;
                        let _ = progress_for_task.send(AppUpdateDownloadProgress::Started {
                            content_length,
                        });
                    }
                    let (downloaded_bytes, known_total) = {
                        let mut guard = chunk_totals.lock().expect("progress mutex");
                        guard.0 = guard.0.saturating_add(chunk_length as u64);
                        if guard.1.is_none() && content_length.is_some() {
                            guard.1 = content_length;
                        }
                        *guard
                    };
                    let _ = progress_for_task.send(AppUpdateDownloadProgress::Progress {
                        downloaded_bytes,
                        content_length: known_total,
                    });
                },
                move || {
                    if !finish_cancelled.load(Ordering::SeqCst) {
                        let (downloaded_bytes, content_length) = *finish_totals.lock().expect("progress mutex");
                        let _ = finish_progress.send(AppUpdateDownloadProgress::Finished {
                            downloaded_bytes,
                            content_length,
                        });
                    }
                },
            )
            .await;
        result.map_err(|error| error.to_string())
    });

    let abort_handle = handle.inner().abort_handle();
    {
        let mut slot = state.inner.lock().map_err(|_| unavailable())?;
        if slot.active_download.is_some() {
            abort_handle.abort();
            return Err("当前已有应用更新正在下载。".to_owned());
        }
        slot.active_download = Some(ActiveDownload {
            id: download_id,
            cancelled: cancelled.clone(),
            abort_fn: Box::new(move || abort_handle.abort()),
        });
    }

    let join_result = handle.await;

    let mut slot = state.inner.lock().map_err(|_| unavailable())?;
    if slot
        .active_download
        .as_ref()
        .is_some_and(|active| active.id == download_id)
    {
        slot.active_download = None;
    }

    if cancelled.load(Ordering::SeqCst) {
        return Err("DOWNLOAD_CANCELLED".to_owned());
    }

    match join_result {
        Ok(Ok(bytes)) => {
            if let Some(pending) = slot
                .pending
                .as_mut()
                .filter(|pending| pending.update.version == version)
            {
                pending.downloaded_bytes = Some(bytes);
                Ok(())
            } else {
                Err("更新会话已过期，请重新检查更新。".to_owned())
            }
        }
        Ok(Err(error)) => Err(error),
        Err(error) => {
            if cancelled.load(Ordering::SeqCst) {
                Err("DOWNLOAD_CANCELLED".to_owned())
            } else {
                Err(format!("下载任务异常结束：{error}"))
            }
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_app_update_download(state: State<'_, AppUpdaterState>) -> Result<(), String> {
    let active = {
        let mut slot = state.inner.lock().map_err(|_| unavailable())?;
        slot.active_download.take()
    };
    if let Some(active) = active {
        active.cancelled.store(true, Ordering::SeqCst);
        (active.abort_fn)();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_app_update_and_relaunch(
    app: tauri::AppHandle,
    state: State<'_, AppUpdaterState>,
    version: String,
) -> Result<(), String> {
    let (update, bytes) = {
        let mut slot = state.inner.lock().map_err(|_| unavailable())?;
        if slot.active_download.is_some() {
            return Err("更新仍在下载中，请等待下载完成。".to_owned());
        }
        let pending = slot
            .pending
            .as_mut()
            .filter(|pending| pending.update.version == version)
            .ok_or_else(|| "未找到该版本的更新包，请重新检查更新。".to_owned())?;
        let bytes = pending
            .downloaded_bytes
            .take()
            .ok_or_else(|| "更新包尚未下载，请先下载更新。".to_owned())?;
        (pending.update.clone(), bytes)
    };

    let bytes_for_install = bytes.clone();
    let install_result = tauri::async_runtime::spawn_blocking(move || {
        update
            .install(&bytes_for_install)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("安装任务未完成：{error}"))?;

    if let Err(error) = install_result {
        if let Ok(mut slot) = state.inner.lock() {
            if let Some(pending) = slot
                .pending
                .as_mut()
                .filter(|pending| pending.update.version == version)
            {
                pending.downloaded_bytes = Some(bytes);
            }
        }
        return Err(format_install_error(&error));
    }

    if let Ok(mut slot) = state.inner.lock() {
        slot.pending = None;
    }
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_app_release_page(url: String) -> Result<(), String> {
    let validated = validate_release_url(&url)?;
    launch_in_system(validated.as_str().as_ref(), "无法在浏览器中打开发布页面。")
}

fn unavailable() -> String {
    "应用更新服务暂时不可用，请重启应用。".to_owned()
}
