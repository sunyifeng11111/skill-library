use crate::app_updater_desktop::{self, AppUpdaterState};
use crate::{
    online_desktop::{self, OnlinePreviews},
    updates_desktop,
};
use skill_library::{
    AgentDirectoryPreview, AgentDraft, AgentPreset, CategoryTarget, ImportOutcome, ImportPreview,
    ImportSelection, InstallAssignmentsPreview, Library, LibraryError, LibrarySnapshot,
    MoveOutcome, SyncOutcome, UnloadPreview,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use uuid::Uuid;

pub(crate) struct DesktopLibrary {
    root: Result<PathBuf, String>,
    opened: Mutex<Option<Arc<Library>>>,
    default_directory: Option<PathBuf>,
}

impl DesktopLibrary {
    fn open(&self) -> Result<Arc<Library>, String> {
        let mut opened = self
            .opened
            .lock()
            .map_err(|_| "Skill 库暂时无法访问，请重启应用。".to_owned())?;
        if let Some(library) = opened.as_ref() {
            return Ok(library.clone());
        }
        let root = self.root.as_ref().map_err(Clone::clone)?;
        let library = match &self.default_directory {
            Some(directory) => Library::open_with_default(root, directory),
            None => Library::open(root),
        }
        .map_err(|error| error.to_string())?;
        let library = Arc::new(library);
        *opened = Some(library.clone());
        Ok(library)
    }
}

pub(crate) async fn run_library<T: Send + 'static>(
    state: State<'_, Arc<DesktopLibrary>>,
    action: impl FnOnce(&Library) -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let library = state.open()?;
        action(&library).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("操作未完成：{error}"))?
}

#[tauri::command]
async fn library_snapshot(
    state: State<'_, Arc<DesktopLibrary>>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, Library::snapshot).await
}

#[tauri::command]
async fn scan_existing_skills(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopLibrary>>,
    collections: Vec<PathBuf>,
    agent_id: Option<Uuid>,
    include_agents: Option<bool>,
    registered_only: Option<bool>,
) -> Result<Vec<skill_library::DiscoveredSkill>, String> {
    if registered_only.unwrap_or(false) {
        return run_library(state, move |library| {
            library.scan_registered_unmanaged_skills(agent_id)
        })
        .await;
    }
    let presets = agent_presets(app)?;
    run_library(state, move |library| {
        library.scan_local_sources(
            &presets,
            &collections,
            agent_id,
            include_agents.unwrap_or(true),
        )
    })
    .await
}

#[tauri::command]
async fn adopt_existing_skills(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopLibrary>>,
    rows: Vec<skill_library::DiscoveredSkill>,
    manage: Option<bool>,
) -> Result<Vec<skill_library::AdoptionResult>, String> {
    let presets = agent_presets(app)?;
    run_library(state, move |library| {
        Ok(if manage.unwrap_or(false) {
            library.manage_existing_skills(&presets, rows)
        } else {
            library.adopt_existing_skills(&presets, rows)
        })
    })
    .await
}

#[tauri::command]
async fn commit_local_batch(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopLibrary>>,
    request: skill_library::UnifiedAdoptionRequest,
) -> Result<skill_library::UnifiedAdoptionOutcome, String> {
    let presets = agent_presets(app)?;
    run_library(state, move |library| {
        library.commit_local_batch(&presets, request)
    })
    .await
}

#[tauri::command]
async fn undo_adoption_batch(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.undo_adoption_batch(id)).await
}

#[tauri::command]
async fn compare_skill_manifests(
    state: State<'_, Arc<DesktopLibrary>>,
    left: PathBuf,
    right: PathBuf,
) -> Result<skill_library::SkillManifestDiff, String> {
    run_library(state, move |library| {
        library.compare_skill_manifests(&left, &right)
    })
    .await
}

#[tauri::command]
async fn trash_broken_link(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopLibrary>>,
    path: PathBuf,
) -> Result<(), String> {
    let presets = agent_presets(app)?;
    run_library(state, move |library| {
        library.trash_broken_link(&path, &presets)
    })
    .await
}

#[tauri::command]
async fn open_in_system(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Err("文件或目录不存在。".to_owned());
    }
    launch_in_system(path.as_os_str(), "无法在系统中打开该路径。")
}

pub(crate) fn launch_in_system(target: &std::ffi::OsStr, failure_message: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(target).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(target).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(target)
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err(failure_message.to_owned()),
        Err(e) => Err(format!("无法打开目标：{e}")),
    }
}

#[tauri::command]
async fn preview_folders(
    state: State<'_, Arc<DesktopLibrary>>,
    paths: Vec<PathBuf>,
) -> Result<ImportPreview, String> {
    run_library(state, move |library| library.preview_folders(paths)).await
}

#[tauri::command]
async fn commit_import(
    state: State<'_, Arc<DesktopLibrary>>,
    selected: Vec<ImportSelection>,
    target: CategoryTarget,
    local: Option<bool>,
    origins: Option<BTreeMap<String, Vec<String>>>,
) -> Result<ImportOutcome, String> {
    run_library(state, move |library| {
        if local.unwrap_or(false) {
            library.collect_local_skills(selected, target, None, origins.unwrap_or_default())
        } else {
            library.commit_import(selected, target)
        }
    })
    .await
}

#[tauri::command]
async fn managed_path(state: State<'_, Arc<DesktopLibrary>>, id: Uuid) -> Result<PathBuf, String> {
    run_library(state, move |library| library.managed_path(id)).await
}

#[tauri::command]
async fn create_category(
    state: State<'_, Arc<DesktopLibrary>>,
    name: String,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.create_category(name)).await
}

#[tauri::command]
async fn rename_category(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
    name: String,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.rename_category(id, name)).await
}

#[tauri::command]
async fn delete_category(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.delete_category(id)).await
}

#[tauri::command]
async fn reorder_categories(
    state: State<'_, Arc<DesktopLibrary>>,
    ids: Vec<Uuid>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.reorder_categories(ids)).await
}

#[tauri::command]
async fn move_skills(
    state: State<'_, Arc<DesktopLibrary>>,
    ids: Vec<Uuid>,
    target: CategoryTarget,
) -> Result<MoveOutcome, String> {
    run_library(state, move |library| library.move_skills(ids, target)).await
}

#[tauri::command]
async fn undo_move(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.undo_move(id)).await
}

#[tauri::command]
fn agent_presets(app: tauri::AppHandle) -> Result<Vec<AgentPreset>, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(skill_library::agent_presets(&home))
}

#[tauri::command]
async fn preview_agent_directory(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopLibrary>>,
    directory: PathBuf,
    agent_id: Option<Uuid>,
) -> Result<AgentDirectoryPreview, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    run_library(state, move |library| {
        library.preview_agent_directory(&directory, &home, agent_id)
    })
    .await
}

#[tauri::command]
async fn add_agent(
    state: State<'_, Arc<DesktopLibrary>>,
    draft: AgentDraft,
    create_directory: Option<bool>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| {
        library.add_agent_with_creation(draft, create_directory.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn remove_agent(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
    shown_skills: Vec<Uuid>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.remove_agent(id, shown_skills)).await
}

#[tauri::command]
async fn change_agent_directory(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
    directory: PathBuf,
    create_directory: Option<bool>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| {
        library.change_agent_directory_with_creation(
            id,
            directory,
            create_directory.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn reorder_agents(
    state: State<'_, Arc<DesktopLibrary>>,
    ids: Vec<Uuid>,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.reorder_agents(ids)).await
}

#[tauri::command]
async fn set_agent_skill(
    state: State<'_, Arc<DesktopLibrary>>,
    agent_id: Uuid,
    skill_id: Uuid,
    enabled: bool,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| {
        library.set_agent_skill(agent_id, skill_id, enabled)
    })
    .await
}

#[tauri::command]
async fn set_category_sync(
    state: State<'_, Arc<DesktopLibrary>>,
    agent_id: Uuid,
    category_id: Option<Uuid>,
    enabled: bool,
) -> Result<SyncOutcome, String> {
    run_library(state, move |library| {
        library.set_category_sync(agent_id, category_id, enabled)
    })
    .await
}

#[tauri::command]
async fn undo_category_sync(
    state: State<'_, Arc<DesktopLibrary>>,
    id: Uuid,
) -> Result<SyncOutcome, String> {
    run_library(state, move |library| library.undo_category_sync(id)).await
}

#[tauri::command]
async fn preview_install_assignments(
    state: State<'_, Arc<DesktopLibrary>>,
    filenames: Vec<String>,
    target: CategoryTarget,
    agents: Vec<Uuid>,
) -> Result<InstallAssignmentsPreview, String> {
    run_library(state, move |library| {
        library.preview_install_assignments(filenames, target, agents)
    })
    .await
}

#[tauri::command]
async fn commit_import_with_agents(
    state: State<'_, Arc<DesktopLibrary>>,
    selected: Vec<ImportSelection>,
    target: CategoryTarget,
    agents: Vec<Uuid>,
    local: Option<bool>,
) -> Result<ImportOutcome, String> {
    run_library(state, move |library| {
        if local.unwrap_or(false) {
            library.collect_local_skills(selected, target, Some(agents), BTreeMap::new())
        } else {
            library.commit_import_with_agents(selected, target, agents)
        }
    })
    .await
}

#[tauri::command]
async fn preview_unload(
    state: State<'_, Arc<DesktopLibrary>>,
    ids: Vec<Uuid>,
) -> Result<UnloadPreview, String> {
    run_library(state, move |library| library.preview_unload(ids)).await
}

#[tauri::command]
async fn unload_skills(
    state: State<'_, Arc<DesktopLibrary>>,
    preview: UnloadPreview,
) -> Result<LibrarySnapshot, String> {
    run_library(state, move |library| library.unload_skills(preview)).await
}

pub(crate) fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let root = match std::env::var_os("SKILL_LIBRARY_ROOT") {
                Some(path) if PathBuf::from(&path).is_absolute() => Ok(PathBuf::from(path)),
                Some(_) => Err("SKILL_LIBRARY_ROOT 需要使用绝对路径。".into()),
                None => app.path().app_data_dir().map_err(|error| error.to_string()),
            };
            let default_directory = if std::env::var_os("SKILL_LIBRARY_ROOT").is_none() {
                Some(app.path().home_dir()?.join(".skill-library").join("skills"))
            } else {
                None
            };
            app.manage(Arc::new(DesktopLibrary {
                default_directory,
                root,
                opened: Mutex::new(None),
            }));
            app.manage(OnlinePreviews::default());
            app.manage(AppUpdaterState::default());
            let config = &app.config().app.windows[0];
            let window = tauri::WebviewWindowBuilder::from_config(app, config)?;
            #[cfg(target_os = "macos")]
            let window = window.transparent(true).effects(
                tauri::window::EffectsBuilder::new()
                    .effect(tauri::window::Effect::Sidebar)
                    .build(),
            );
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_snapshot,
            preview_folders,
            commit_import,
            managed_path,
            create_category,
            rename_category,
            delete_category,
            reorder_categories,
            move_skills,
            undo_move,
            agent_presets,
            scan_existing_skills,
            adopt_existing_skills,
            commit_local_batch,
            undo_adoption_batch,
            compare_skill_manifests,
            trash_broken_link,
            open_in_system,
            preview_agent_directory,
            add_agent,
            remove_agent,
            change_agent_directory,
            reorder_agents,
            set_agent_skill,
            set_category_sync,
            undo_category_sync,
            preview_install_assignments,
            commit_import_with_agents,
            preview_unload,
            unload_skills,
            crate::settings_desktop::change_managed_directory,
            crate::settings_desktop::settings_preferences,
            crate::settings_desktop::set_settings_preferences,
            crate::settings_desktop::export_library_backup,
            crate::settings_desktop::preview_library_backup,
            crate::settings_desktop::restore_library_backup,
            crate::settings_desktop::preview_library_defaults,
            crate::settings_desktop::restore_library_defaults,
            crate::settings_desktop::list_original_backups,
            crate::settings_desktop::restore_original_backup,
            crate::settings_desktop::delete_original_backup,
            online_desktop::reserve_package_preview,
            online_desktop::read_package_preview,
            online_desktop::discard_package_preview,
            online_desktop::attach_package_source,
            updates_desktop::check_package_updates,
            updates_desktop::check_package_update,
            updates_desktop::preview_package_update,
            updates_desktop::apply_package_update,
            updates_desktop::open_source_url,
            app_updater_desktop::app_update_info,
            app_updater_desktop::check_app_update,
            app_updater_desktop::download_app_update,
            app_updater_desktop::cancel_app_update_download,
            app_updater_desktop::install_app_update_and_relaunch,
            app_updater_desktop::open_app_release_page,
        ])
        .run(tauri::generate_context!())
        .expect("Skill Library could not start");
}
