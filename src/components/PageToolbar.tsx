import {
  LayoutGridIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import type { AppPage } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";

export interface ShellChromeContextValue {
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onNavigate: (next: AppPage) => void;
  onOpenSettings: () => void;
}

export const ShellChromeContext = React.createContext<ShellChromeContextValue | null>(null);

const PAGE_SCROLL_FADE_MASK =
  "linear-gradient(to bottom, transparent 0%, rgb(0 0 0 / 0.16) 24px, rgb(0 0 0 / 0.58) 46px, #000 68px, #000 100%)";

const PAGE_SCROLL_FADE_STYLE: React.CSSProperties = {
  WebkitMaskImage: PAGE_SCROLL_FADE_MASK,
  maskImage: PAGE_SCROLL_FADE_MASK,
};

const TOOLBAR_BLUR_MASK_STYLE: React.CSSProperties = {
  WebkitMaskImage: "linear-gradient(to bottom, #000 0%, #000 calc(100% - 20px), transparent 100%)",
  maskImage: "linear-gradient(to bottom, #000 0%, #000 calc(100% - 20px), transparent 100%)",
};

export function useScrolled(resetKey?: string): {
  scrolled: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  scrollStyle: React.CSSProperties;
} {
  const [scrolled, setScrolled] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    setScrolled(false);
  }, [resetKey]);

  const onScroll = React.useCallback<React.UIEventHandler<HTMLDivElement>>((event) => {
    const next = event.currentTarget.scrollTop > 0;
    setScrolled((prev) => (prev === next ? prev : next));
  }, []);

  return { scrolled, scrollRef, onScroll, scrollStyle: PAGE_SCROLL_FADE_STYLE };
}

export function PageToolbar({
  breadcrumb,
  actions,
  scrolled = false,
}: {
  breadcrumb: string;
  actions?: React.ReactNode;
  scrolled?: boolean;
}): React.ReactElement {
  const { desktop, snapshot, page, setPage, openSettings, appUpdates } = useApp();
  const chrome = React.useContext(ShellChromeContext);

  const sidebarCollapsed = chrome?.sidebarCollapsed ?? false;
  const onExpandSidebar = chrome?.onExpandSidebar ?? (() => {});
  const onNavigate = chrome?.onNavigate ?? setPage;
  const onOpenSettings = chrome?.onOpenSettings ?? (() => openSettings());

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 -bottom-5 bg-background/72 backdrop-blur-md transition-opacity duration-200",
          scrolled ? "opacity-100" : "opacity-0",
        )}
        style={TOOLBAR_BLUR_MASK_STYLE}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 -bottom-7 bg-linear-to-b from-black/[0.03] via-black/[0.012] to-transparent transition-opacity duration-200 dark:from-black/35 dark:via-black/15 dark:to-transparent",
          scrolled ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "pointer-events-auto relative flex h-12 select-none items-center justify-between gap-3",
          sidebarCollapsed ? "pr-4 pl-23 sm:pr-6" : "pr-4 pl-23 md:px-6",
        )}
        data-tauri-drag-region=""
        onMouseDown={(e) => {
          if (
            e.button === 0 &&
            e.detail >= 2 &&
            (e.target as HTMLElement).hasAttribute("data-tauri-drag-region")
          ) {
            e.preventDefault();
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region="">
          <div
            className={cn("flex shrink-0 items-center gap-1", !sidebarCollapsed && "md:hidden")}
          >
            <Button
              aria-label={tr("展开侧栏", "Open sidebar")}
              size="icon-sm"
              title={tr("展开侧栏", "Open sidebar")}
              variant="ghost"
              onClick={onExpandSidebar}
            >
              <PanelLeftOpenIcon />
            </Button>
            {sidebarCollapsed && (
              <>
                <Button
                  aria-current={page.kind === "all" ? "page" : undefined}
                  aria-label={tr("全部 Skill", "All skills")}
                  className="hidden md:inline-flex"
                  disabled={!snapshot}
                  size="icon-sm"
                  title={tr("全部 Skill", "All skills")}
                  variant="ghost"
                  onClick={() => onNavigate({ kind: "all" })}
                >
                  <LayoutGridIcon />
                </Button>
                {desktop.updates && (
                  <Button
                    aria-current={page.kind === "updates" ? "page" : undefined}
                    aria-label={tr("更新中心", "Updates")}
                    className="hidden md:inline-flex"
                    disabled={!snapshot}
                    size="icon-sm"
                    title={tr("更新中心", "Updates")}
                    variant="ghost"
                    onClick={() => onNavigate({ kind: "updates" })}
                  >
                    <RefreshCwIcon />
                  </Button>
                )}
                {desktop.settings && (
                  <Button
                    aria-haspopup="dialog"
                    aria-label={
                      appUpdates.hasBadge
                        ? tr("设置（有可用的应用更新）", "Settings (app update available)")
                        : tr("设置", "Settings")
                    }
                    className="relative hidden md:inline-flex"
                    disabled={!snapshot}
                    size="icon-sm"
                    title={tr("设置", "Settings")}
                    variant="ghost"
                    onClick={onOpenSettings}
                  >
                    <SettingsIcon />
                    {appUpdates.hasBadge && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-info"
                        data-app-update-dot=""
                      />
                    )}
                  </Button>
                )}
              </>
            )}
            {sidebarCollapsed && (
              <Separator className="mx-1 hidden h-4 md:block" orientation="vertical" />
            )}
          </div>

          <span
            className="min-w-0 truncate text-muted-foreground text-xs"
            data-tauri-drag-region=""
            title={breadcrumb}
          >
            {breadcrumb}
          </span>
        </div>

        {actions && <div className="flex shrink-0 select-text items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
