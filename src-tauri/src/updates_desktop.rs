use crate::{
    desktop::{run_library, DesktopLibrary},
    online_desktop::git_source,
};
use skill_library::{
    PackageUpdateCheck, PackageUpdateOutcome, PackageUpdatePreview, PackageUpdateSelection,
    SourceCancellation, UpdatePackage,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn check_package_updates(
    state: State<'_, Arc<DesktopLibrary>>,
) -> Result<Vec<PackageUpdateCheck>, String> {
    run_library(state, |library| {
        library.check_package_updates(&git_source(), &SourceCancellation::default())
    })
    .await
}

#[tauri::command]
pub(crate) async fn check_package_update(
    state: State<'_, Arc<DesktopLibrary>>,
    package: UpdatePackage,
) -> Result<PackageUpdateCheck, String> {
    run_library(state, move |library| {
        library.check_package_update(&git_source(), &package, &SourceCancellation::default())
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_package_update(
    state: State<'_, Arc<DesktopLibrary>>,
    package: UpdatePackage,
    revision: String,
) -> Result<PackageUpdatePreview, String> {
    run_library(state, move |library| {
        library.preview_package_update(
            &git_source(),
            &package,
            &revision,
            &SourceCancellation::default(),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_package_update(
    state: State<'_, Arc<DesktopLibrary>>,
    package: UpdatePackage,
    selection: PackageUpdateSelection,
) -> Result<PackageUpdateOutcome, String> {
    run_library(state, move |library| {
        library.apply_package_update(
            &git_source(),
            &package,
            &selection,
            &SourceCancellation::default(),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_source_url(
    state: State<'_, Arc<DesktopLibrary>>,
    url: String,
) -> Result<(), String> {
    let validated =
        run_library(state, move |library| library.validate_tracked_source_url(&url)).await?;
    crate::desktop::launch_in_system(validated.as_str().as_ref(), "无法在浏览器中打开仓库页面。")
}
