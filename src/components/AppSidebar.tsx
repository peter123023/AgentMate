import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsLeft, ChevronsRight, Settings } from "lucide-react";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { cn } from "@/lib/utils";
import { AppGlyph } from "@/components/AppSwitcher";
import { APP_IDS } from "@/config/appConfig";

const COLLAPSE_STORAGE_KEY = "model-board-sidebar-collapsed";

interface AppSidebarProps {
  activeApp: AppId;
  onSwitch: (app: AppId) => void;
  visibleApps?: VisibleApps;
  onOpenSettings: () => void;
  settingsActive?: boolean;
}

export function AppSidebar({
  activeApp,
  onSwitch,
  visibleApps,
  onOpenSettings,
  settingsActive,
}: AppSidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true",
  );

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
  };

  const appsToShow = APP_IDS.filter((app) => {
    if (!visibleApps) return true;
    return visibleApps[app];
  });

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-background/60",
        "transition-[width] duration-200 ease-in-out",
        collapsed ? "w-16" : "w-[200px]",
      )}
    >
      {/* 顶部：收起按钮（仅图标，位于左侧顶部） */}
      <div className="flex h-12 shrink-0 items-center justify-start border-b border-border px-2">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={!collapsed}
          title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground",
            "transition-colors duration-150 hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {collapsed ? (
            <ChevronsRight size={18} className="shrink-0" />
          ) : (
            <ChevronsLeft size={18} className="shrink-0" />
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {appsToShow.map((app) => {
          const isActive = app === activeApp;
          const label = t(`apps.${app}`);
          return (
            <button
              key={app}
              type="button"
              onClick={() => onSwitch(app)}
              title={label}
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex h-10 w-full items-center rounded-lg transition-colors duration-150",
                collapsed ? "justify-center px-0" : "gap-3 px-3",
                isActive
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <AppGlyph app={app} isActive={isActive} />
              {!collapsed && <span className="truncate text-sm">{label}</span>}
            </button>
          );
        })}
      </nav>

      {/* 底部：设置（图标 + 文字，位于左侧底部） */}
      <div className="flex shrink-0 border-t border-border p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
          aria-current={settingsActive ? "page" : undefined}
          className={cn(
            "flex h-10 w-full items-center rounded-lg transition-colors duration-150",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
            settingsActive
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          <Settings size={18} className="shrink-0" />
          {!collapsed && (
            <span className="truncate text-sm">{t("common.settings")}</span>
          )}
        </button>
      </div>
    </aside>
  );
}
