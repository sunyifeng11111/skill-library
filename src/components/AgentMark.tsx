import { FolderIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import type { Agent } from "@/shared/library";

const logoFiles = import.meta.glob<string>("../features/agents/logos/*.{png,svg}", {
  eager: true,
  query: "?url",
  import: "default",
});

const invertInDark = new Set([
  "augment",
  "codex",
  "githubCopilot",
  "goose",
  "mux",
  "neovate",
  "rooCode",
  "warp",
]);
const invertInLight = new Set(["commandCode"]);

export function AgentMark({
  agent,
  className,
}: {
  agent: Pick<Agent, "kind" | "name">;
  className?: string;
}): React.ReactElement {
  const key = agent.kind === "workbuddyOverseas" ? "workbuddy" : agent.kind;
  const logo =
    logoFiles[`../features/agents/logos/${key}.png`] ??
    logoFiles[`../features/agents/logos/${key}.svg`];

  if (agent.kind === "sharedSkills") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground",
          className,
        )}
      >
        <FolderIcon className="size-4" />
      </span>
    );
  }

  if (logo) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px]",
          invertInDark.has(key) && "agent-mark-invert-dark",
          invertInLight.has(key) && "agent-mark-invert-light",
          className,
        )}
      >
        <img alt="" className="size-full object-contain" draggable={false} src={logo} />
      </span>
    );
  }

  const words = agent.name.split(/[\s_-]+/u).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => [...word][0])
          .join("")
      : [...agent.name].slice(0, 2).join("");

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-muted font-semibold text-[9px] text-foreground leading-none",
        className,
      )}
    >
      {initials.toLocaleUpperCase()}
    </span>
  );
}
