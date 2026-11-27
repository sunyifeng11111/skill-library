import type * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tr } from "@/shared/language";
import type { Category, CategoryTarget } from "@/shared/library";

const NEW_VALUE = "__new__";
const UNCATEGORIZED_VALUE = "__uncategorized__";

export function CategoryPicker({
  categories,
  value,
  onChange,
  addLabel,
  disabled,
  invalid,
}: {
  categories: Category[];
  value: CategoryTarget;
  onChange: (next: CategoryTarget) => void;
  addLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
}): React.ReactElement {
  const selectValue =
    value.kind === "existing"
      ? value.id
      : value.kind === "new"
        ? NEW_VALUE
        : UNCATEGORIZED_VALUE;

  const newLabel = addLabel ?? tr("＋ 新建分类", "+ New category");

  const items = [
    { value: UNCATEGORIZED_VALUE, label: tr("未分类", "Uncategorized") },
    ...categories.map((cat) => ({ value: cat.id, label: cat.name })),
    { value: NEW_VALUE, label: newLabel },
  ];

  const currentLabel =
    items.find((item) => item.value === selectValue)?.label ?? tr("未分类", "Uncategorized");

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <Label>{tr("目标分类", "Category")}</Label>
        <Select
          disabled={disabled}
          value={selectValue}
          onValueChange={(next) => {
            if (!next || next === UNCATEGORIZED_VALUE) {
              onChange({ kind: "uncategorized" });
            } else if (next === NEW_VALUE) {
              onChange({ kind: "new", name: value.kind === "new" ? value.name : "" });
            } else {
              onChange({ kind: "existing", id: next });
            }
          }}
        >
          <SelectTrigger aria-label={tr("目标分类", "Category")}>
            <SelectValue>{currentLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {value.kind === "new" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="category-picker-new-name">{tr("新分类名称", "New category name")}</Label>
          <Input
            aria-invalid={invalid || undefined}
            autoFocus
            disabled={disabled}
            id="category-picker-new-name"
            placeholder={tr("例如：写作", "e.g. Writing")}
            value={value.name}
            onChange={(e) => onChange({ kind: "new", name: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

export function validateCategoryTarget(target: CategoryTarget): CategoryTarget {
  if (target.kind === "new") {
    const name = target.name.trim();
    if (!name) throw new Error(tr("请输入新分类名称。", "Enter a category name."));
    return { kind: "new", name };
  }
  return target;
}
