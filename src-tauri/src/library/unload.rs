use super::{Library, Registry};
use crate::{LibraryError, LibrarySnapshot, UnloadAgent, UnloadMember, UnloadPreview};
use std::collections::BTreeSet;
use uuid::Uuid;

impl Library {
    pub fn preview_unload(&self, ids: Vec<Uuid>) -> Result<UnloadPreview, LibraryError> {
        self.registry()?.preview_unload(ids)
    }

    pub fn unload_skills(&self, preview: UnloadPreview) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        let ids: BTreeSet<_> = preview.members.iter().map(|member| member.id).collect();
        if current.preview_unload(ids.iter().copied())? != preview {
            return Err(LibraryError::new(
                "受影响的成员或 Agent 已发生变化，请重新预览。",
            ));
        }

        let mut next = current.clone();
        next.skills.retain(|member| !ids.contains(&member.skill.id));
        for agent in &mut next.agents {
            for id in &ids {
                agent.forget_member(*id);
            }
        }
        let staging = self.stage_content(&current)?;
        self.publish_transaction(&mut current, next, Some(staging))?;
        Ok(self.snapshot_for(&current))
    }
}

impl Registry {
    fn preview_unload(
        &self,
        ids: impl IntoIterator<Item = Uuid>,
    ) -> Result<UnloadPreview, LibraryError> {
        let ids: BTreeSet<_> = ids.into_iter().collect();
        if ids.is_empty() {
            return Err(LibraryError::new("请选择要卸载的 Skill。"));
        }
        let members: Vec<_> = ids
            .into_iter()
            .map(|id| self.skill(id))
            .collect::<Result<_, _>>()?;
        let agents = self
            .agents
            .iter()
            .filter_map(|agent| {
                let paths: Vec<_> = members
                    .iter()
                    .filter_map(|member| agent.assignment(member).path)
                    .collect();
                (!paths.is_empty()).then(|| UnloadAgent {
                    id: agent.agent.id,
                    name: agent.agent.name.clone(),
                    paths,
                })
            })
            .collect();
        Ok(UnloadPreview {
            members: members
                .into_iter()
                .map(|member| UnloadMember {
                    id: member.skill.id,
                    name: member.skill.name.clone(),
                })
                .collect(),
            agents,
        })
    }
}
