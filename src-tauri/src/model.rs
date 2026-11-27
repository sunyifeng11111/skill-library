use crate::AgentKind;
use serde::{Deserialize, Serialize};
use std::{
    fmt, io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct LibraryError(String);

impl LibraryError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub(crate) fn io(action: &str, path: &Path, error: io::Error) -> Self {
        Self(format!("{action} {}：{error}", path.display()))
    }
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for LibraryError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_origins: Vec<String>,
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub folder_name: String,
    pub fingerprint: String,
    pub category_id: Option<Uuid>,
    pub source: Option<PackageSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSource {
    pub repository: String,
    pub member_path: String,
    /// Empty when a local variant has a linked source but no installed upstream revision.
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub managed_directory: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_notice: Option<String>,
    pub skills: Vec<Skill>,
    pub categories: Vec<Category>,
    pub agents: Vec<Agent>,
    pub assignments: Vec<AgentAssignment>,
    pub last_install_agents: Vec<Uuid>,
    pub original_backup_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentPreset {
    pub kind: AgentKind,
    pub name: &'static str,
    pub directory: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct AgentDirectoryPreview {
    pub directory: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDraft {
    pub kind: AgentKind,
    pub name: String,
    pub directory: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: Uuid,
    pub kind: AgentKind,
    pub name: String,
    pub directory: PathBuf,
    #[serde(default)]
    pub synced_categories: std::collections::BTreeSet<Uuid>,
    #[serde(default)]
    pub sync_uncategorized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAssignment {
    pub agent_id: Uuid,
    pub skill_id: Uuid,
    pub direct: bool,
    pub via_category: bool,
    pub excluded: bool,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImpact {
    pub enabled: usize,
    pub disabled: usize,
    pub retained_direct: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncOutcome {
    pub library: LibrarySnapshot,
    pub impact: SyncImpact,
    pub undo: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAgentTarget {
    pub agent_id: Uuid,
    pub direct: bool,
    pub via_category: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallAssignmentsPreview {
    pub targets: Vec<InstallAgentTarget>,
    pub conflicts: Vec<PreviewProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnloadPreview {
    pub members: Vec<UnloadMember>,
    pub agents: Vec<UnloadAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnloadMember {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnloadAgent {
    pub id: Uuid,
    pub name: String,
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CategoryTarget {
    Uncategorized,
    Existing { id: Uuid },
    New { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewStatus {
    Ready,
    Duplicate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMember {
    pub path: PathBuf,
    pub name: String,
    pub description: String,
    pub folder_name: String,
    pub fingerprint: String,
    pub status: PreviewStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewProblem {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub members: Vec<PreviewMember>,
    pub problems: Vec<PreviewProblem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub path: PathBuf,
    pub fingerprint: String,
    pub source: Option<PackageSource>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    pub library: LibrarySnapshot,
    pub added: Vec<Uuid>,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveOutcome {
    pub library: LibrarySnapshot,
    pub moved: usize,
    pub undo: Option<Uuid>,
}
