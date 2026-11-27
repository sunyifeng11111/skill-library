import { LayoutGridIcon, ListIcon } from "lucide-react";
import type * as React from "react";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { tr } from "@/shared/language";
import type { SkillViewMode } from "@/shared/view-mode";

export function SkillViewModeControl({
  value,
  onChange,
}: {
  value: SkillViewMode;
  onChange: (next: SkillViewMode) => void;
}): React.ReactElement {
  return (
    <SegmentedControl
      aria-label={tr("视图方式", "View mode")}
      role="group"
      size="sm"
    >
      <SegmentedControlItem
        aria-label={tr("网格视图", "Grid view")}
        aria-pressed={value === "grid"}
        data-pressed={value === "grid" ? "" : undefined}
        title={tr("网格视图", "Grid view")}
        onClick={() => onChange("grid")}
      >
        <LayoutGridIcon />
      </SegmentedControlItem>
      <SegmentedControlItem
        aria-label={tr("列表视图", "List view")}
        aria-pressed={value === "list"}
        data-pressed={value === "list" ? "" : undefined}
        title={tr("列表视图", "List view")}
        onClick={() => onChange("list")}
      >
        <ListIcon />
      </SegmentedControlItem>
    </SegmentedControl>
  );
}
