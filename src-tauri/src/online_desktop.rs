use crate::desktop::{run_library, DesktopLibrary};
use skill_library::{
    online::{DownloadedPackage, PackageProposal},
    GitSource, LibrarySnapshot, SourceCancellation, SourceProgress, SourceRequest,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct OnlinePreviews(Mutex<HashMap<Uuid, Arc<Session>>>);

#[derive(Default)]
struct Session {
    cancellation: SourceCancellation,
    phase: Mutex<Phase>,
}

#[derive(Default)]
enum Phase {
    #[default]
    Reserved,
    Reading,
    Ready {
        download: Arc<DownloadedPackage>,
    },
}

#[tauri::command]
pub(crate) fn reserve_package_preview(previews: State<'_, OnlinePreviews>) -> Result<Uuid, String> {
    let id = Uuid::new_v4();
    previews
        .0
        .lock()
        .map_err(|_| unavailable())?
        .insert(id, Arc::new(Session::default()));
    Ok(id)
}

#[tauri::command]
pub(crate) async fn read_package_preview(
    state: State<'_, Arc<DesktopLibrary>>,
    previews: State<'_, OnlinePreviews>,
    id: Uuid,
    input: String,
    progress: Channel<SourceProgress>,
) -> Result<PackageProposal, String> {
    let session = previews
        .0
        .lock()
        .map_err(|_| unavailable())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "此安装预览已关闭，请重新读取来源。".to_owned())?;
    {
        let mut phase = session.phase.lock().map_err(|_| unavailable())?;
        if !matches!(*phase, Phase::Reserved) {
            return Err("此来源已开始读取。".into());
        }
        *phase = Phase::Reading;
    }

    let worker = session.clone();
    let (downloaded, proposal) = run_library(state, move |library| {
        let request = SourceRequest::parse(&input)?;
        let git = git_source();
        let downloaded = git.download(&request, &worker.cancellation, |step| {
            let _ = progress.send(step);
        })?;
        let proposal = downloaded.propose(library, &worker.cancellation)?;
        Ok((downloaded, proposal))
    })
    .await?;
    // A concurrently discarded session drops the files when this last reference goes away.
    *session.phase.lock().map_err(|_| unavailable())? = Phase::Ready {
        download: Arc::new(downloaded),
    };
    Ok(proposal)
}

#[tauri::command]
pub(crate) async fn attach_package_source(
    state: State<'_, Arc<DesktopLibrary>>,
    previews: State<'_, OnlinePreviews>,
    id: Uuid,
    preview_id: Uuid,
    member_path: String,
) -> Result<LibrarySnapshot, String> {
    let expired = || "此来源预览已关闭。请重新预览。".to_owned();
    let session = previews
        .0
        .lock()
        .map_err(|_| unavailable())?
        .get(&preview_id)
        .cloned()
        .ok_or_else(expired)?;
    let download = match &*session.phase.lock().map_err(|_| unavailable())? {
        Phase::Ready { download } => download.clone(),
        _ => return Err(expired()),
    };
    run_library(state, move |library| {
        library.attach_package_source(id, &download, &member_path, &session.cancellation)
    })
    .await
}

pub(crate) fn git_source() -> GitSource {
    std::env::var_os("GIT_CONFIG_GLOBAL")
        .map(GitSource::with_config)
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn discard_package_preview(
    previews: State<'_, OnlinePreviews>,
    id: Uuid,
) -> Result<(), String> {
    let session = previews.0.lock().map_err(|_| unavailable())?.remove(&id);
    if let Some(session) = session {
        session.cancellation.cancel();
    }
    Ok(())
}

fn unavailable() -> String {
    "在线安装暂时无法访问，请重启应用。".into()
}
