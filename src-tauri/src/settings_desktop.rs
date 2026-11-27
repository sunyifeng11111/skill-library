use crate::desktop::{run_library, DesktopLibrary};
use skill_library::{
    Library, Preferences, ReplacementPreview, ResetBackupPolicy, SettingsOutcome,
};
use std::{path::PathBuf, sync::Arc};
use tauri::State;

#[tauri::command]
pub(crate) async fn change_managed_directory(
    state: State<'_, Arc<DesktopLibrary>>,
    path: PathBuf,
) -> Result<skill_library::LibrarySnapshot, String> {
    run_library(state, move |library| {
        library.change_managed_directory(&path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn settings_preferences(
    state: State<'_, Arc<DesktopLibrary>>,
) -> Result<Preferences, String> {
    run_library(state, Library::preferences).await
}

#[tauri::command]
pub(crate) async fn set_settings_preferences(
    state: State<'_, Arc<DesktopLibrary>>,
    preferences: Preferences,
) -> Result<Preferences, String> {
    run_library(state, move |library| library.set_preferences(preferences)).await
}

#[tauri::command]
pub(crate) async fn export_library_backup(
    state: State<'_, Arc<DesktopLibrary>>,
    path: PathBuf,
) -> Result<(), String> {
    run_library(state, move |library| library.export_backup(path)).await
}

#[tauri::command]
pub(crate) async fn preview_library_backup(
    state: State<'_, Arc<DesktopLibrary>>,
    path: PathBuf,
) -> Result<ReplacementPreview, String> {
    run_library(state, move |library| library.preview_backup(path)).await
}

#[tauri::command]
pub(crate) async fn restore_library_backup(
    state: State<'_, Arc<DesktopLibrary>>,
    path: PathBuf,
    preview: ReplacementPreview,
) -> Result<SettingsOutcome, String> {
    run_library(state, move |library| library.restore_backup(path, &preview)).await
}

#[tauri::command]
pub(crate) async fn preview_library_defaults(
    state: State<'_, Arc<DesktopLibrary>>,
) -> Result<ReplacementPreview, String> {
    run_library(state, Library::preview_defaults).await
}

#[tauri::command]
pub(crate) async fn restore_library_defaults(
    state: State<'_, Arc<DesktopLibrary>>,
    preview: ReplacementPreview,
    backup_policy: Option<ResetBackupPolicy>,
) -> Result<SettingsOutcome, String> {
    run_library(state, move |library| {
        library.restore_defaults_with_policy(&preview, backup_policy.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_original_backups(
    state: State<'_, Arc<DesktopLibrary>>,
) -> Result<Vec<skill_library::OriginalBackupSummary>, String> {
    run_library(state, Library::list_original_backups).await
}

#[tauri::command]
pub(crate) async fn restore_original_backup(
    state: State<'_, Arc<DesktopLibrary>>,
    id: uuid::Uuid,
) -> Result<skill_library::LibrarySnapshot, String> {
    run_library(state, move |library| library.restore_original_backup(id)).await
}

#[tauri::command]
pub(crate) async fn delete_original_backup(
    state: State<'_, Arc<DesktopLibrary>>,
    id: uuid::Uuid,
) -> Result<Vec<skill_library::OriginalBackupSummary>, String> {
    run_library(state, move |library| library.delete_original_backup(id)).await
}

