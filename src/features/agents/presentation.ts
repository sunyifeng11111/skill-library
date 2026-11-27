import { tr } from "../../shared/language";
import type { AgentAssignment } from "../../shared/library";

export function assignmentReason(assignment: AgentAssignment, category: string) {
  const direct = assignment.direct ? tr("单独启用", "Enabled individually") : "";
  const inherited = assignment.viaCategory
    ? tr(`随「${category}」同步`, `Synced with “${category}”`)
    : "";
  return (
    [direct, inherited].filter(Boolean).join(" ＋ ") ||
    (assignment.excluded
      ? tr("在此分类中单独停用", "Disabled individually in this category")
      : "")
  );
}
