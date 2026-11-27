import { FolderOpenIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tr } from "@/shared/language";
import type { AgentDirectoryPreview, AgentGateway } from "@/shared/library";
import { errorText } from "@/shared/ui";

export interface AgentDirectoryState {
  path: string;
  preview: AgentDirectoryPreview | null;
  checking: boolean;
  choosing: boolean;
  error: string | null;
}

export function AgentDirectoryField({
  gateway,
  agentId,
  path,
  onPathChange,
  externalError,
  disabled,
  autoFocus,
  inputRef,
  onStateChange,
}: {
  gateway: AgentGateway;
  agentId?: string;
  path: string;
  onPathChange: (next: string) => void;
  externalError?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onStateChange: (state: AgentDirectoryState) => void;
}): React.ReactElement {
  const [preview, setPreview] = React.useState<AgentDirectoryPreview | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [choosing, setChoosing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const revisionRef = React.useRef(0);
  const prefix = agentId === undefined ? "add-agent-directory" : "edit-agent-directory";
  const lastProgrammaticRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const rev = ++revisionRef.current;
    setPreview(null);
    setError(null);
    if (!path) {
      setChecking(false);
      return;
    }

    setChecking(true);
    const immediate = lastProgrammaticRef.current === path;
    lastProgrammaticRef.current = null;

    const inspect = async () => {
      try {
        const result = await gateway.previewDirectory(path, agentId);
        if (revisionRef.current !== rev) return;
        setPreview(result);
        setError(null);
      } catch (reason) {
        if (revisionRef.current !== rev) return;
        setPreview(null);
        setError(errorText(reason));
      } finally {
        if (revisionRef.current === rev) setChecking(false);
      }
    };

    if (immediate) {
      void inspect();
      return;
    }
    const timer = window.setTimeout(() => void inspect(), 150);
    return () => window.clearTimeout(timer);
  }, [gateway, agentId, path]);

  const effectiveError = externalError ?? error;

  React.useEffect(() => {
    onStateChange({ path, preview, checking, choosing, error: effectiveError });
  }, [path, preview, checking, choosing, effectiveError, onStateChange]);

  async function handleChoose() {
    if (choosing || disabled) return;
    const rev = revisionRef.current;
    setChoosing(true);
    try {
      const picked = await gateway.chooseDirectory();
      if (picked && revisionRef.current === rev) {
        lastProgrammaticRef.current = picked;
        onPathChange(picked);
      }
    } catch (reason) {
      if (revisionRef.current === rev) {
        setError(errorText(reason));
      }
    } finally {
      setChoosing(false);
    }
  }

  const showPreviewPath = preview && (!preview.exists || preview.directory !== path);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${prefix}-input`}>
        {tr("这个工具的 Skill 文件夹", "Skills folder for this tool")}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          aria-describedby={`${prefix}-preview ${prefix}-error`}
          aria-invalid={Boolean(effectiveError) || undefined}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 font-mono text-xs"
          disabled={disabled}
          id={`${prefix}-input`}
          placeholder="~/Tools/my-agent/skills"
          spellCheck={false}
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
        />
        <Button
          className="shrink-0"
          disabled={disabled || choosing}
          size="default"
          variant="outline"
          onClick={() => void handleChoose()}
        >
          <FolderOpenIcon />
          {tr("选择文件夹", "Choose folder")}
        </Button>
      </div>

      {checking && path && !effectiveError && (
        <p className="text-muted-foreground text-xs" id={`${prefix}-preview`} role="status">
          {tr("正在检查目录…", "Checking folder…")}
        </p>
      )}
      {!checking && showPreviewPath && !effectiveError && (
        <p className="break-all font-mono text-muted-foreground text-xs" id={`${prefix}-preview`} role="status">
          {preview.directory}
          {!preview.exists && (
            <span className="ml-1.5 font-sans text-warning-foreground">
              {tr("（目录不存在，保存时将自动创建）", "(Does not exist yet; will be created)")}
            </span>
          )}
        </p>
      )}
      {effectiveError && (
        <p className="text-destructive-foreground text-xs" id={`${prefix}-error`} role="alert">
          {effectiveError}
        </p>
      )}
    </div>
  );
}
