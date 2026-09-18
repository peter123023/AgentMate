import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpToLine, Settings } from "lucide-react";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { cn } from "@/lib/utils";
import { AppGlyph } from "@/components/AppSwitcher";
import { OverviewIcon } from "@/components/OverviewIcon";
import { APP_IDS } from "@/config/appConfig";

const PINNED_APPS_STORAGE_KEY = "agentmate-sidebar-pinned-apps";

// 打字/擦除逐字间隔；侧边栏宽度过渡时长 = 字数 × 间隔，保证两者同步。
// 顶部横栏的品牌行（App.tsx）复用同一组间隔，使两处动画节奏一致。
export const TYPE_INTERVAL_MS = 45;
export const ERASE_INTERVAL_MS = 100;

interface AppSidebarProps {
  activeApp: AppId;
  onSwitch: (app: AppId) => void;
  visibleApps?: VisibleApps;
  onOpenSettings: () => void;
  settingsActive?: boolean;
  onOpenHome: () => void;
  homeActive?: boolean;
  /** 当前侧边栏宽度（展开 192 / 收起 48），供外部绘制需与栏宽对齐的装饰层 */
  onWidthChange?: (width: number) => void;
  /** 受控的收起状态：由 App 顶部横栏的品牌行切换按钮驱动，侧边栏与横栏共享 */
  collapsed?: boolean;
}

/** 侧边栏展开/收起宽度，供外部对齐使用 */
export const SIDEBAR_EXPANDED_WIDTH = 192;
export const SIDEBAR_COLLAPSED_WIDTH = 48;

export function AppSidebar({
  activeApp,
  onSwitch,
  visibleApps,
  onOpenSettings,
  settingsActive,
  onOpenHome,
  homeActive,
  onWidthChange,
  collapsed = false,
}: AppSidebarProps) {
  const { t } = useTranslation();

  // 宽度过渡时长：与标题字数联动，使栏宽动画与品牌行文字动画同步
  const title = t("app.title");
  const widthTransitionMs =
    title.length * (collapsed ? ERASE_INTERVAL_MS : TYPE_INTERVAL_MS);

  // 上报当前宽度，供外部绘制需与栏宽对齐的装饰层（如顶部横栏底色）
  useEffect(() => {
    onWidthChange?.(
      collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
    );
  }, [collapsed, onWidthChange]);

  // 置顶的 Agent 列表（有序，新的置顶插到最前），持久化到 localStorage
  const [pinnedApps, setPinnedApps] = useState<AppId[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_APPS_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter(
            (a): a is AppId =>
              typeof a === "string" &&
              (APP_IDS as readonly string[]).includes(a),
          )
        : [];
    } catch {
      return [];
    }
  });

  // 置顶 = 把该项移到列表最前面（已在最顶的项不显示置顶按钮）
  const pinToTop = (app: AppId) => {
    setPinnedApps((prev) => {
      const next = [app, ...prev.filter((a) => a !== app)];
      localStorage.setItem(PINNED_APPS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // 置顶的排前面（按置顶顺序），其余保持默认顺序
  const orderedApps = useMemo(() => {
    const apps = APP_IDS.filter((app) => !visibleApps || visibleApps[app]);
    const pinned = pinnedApps.filter((app) => apps.includes(app));
    return [...pinned, ...apps.filter((app) => !pinned.includes(app))];
  }, [pinnedApps, visibleApps]);

  return (
    <aside
      className={cn(
        // 窗口骨架：位于 App.tsx 根容器（flex-col）的第二行，顶部横栏之外，
        // 无需再做红绿灯/横栏避让；品牌行在横栏内，导航从侧边栏顶部直接开始。
        "relative flex shrink-0 flex-col border-r border-border bg-sidebar",
        "transition-[width] ease-in-out",
        collapsed ? "w-12" : "w-48",
      )}
      data-sidebar-width={
        collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH
      }
      style={{
        transitionDuration: `${widthTransitionMs}ms`,
      }}
    >
      {/* 品牌行已移至 App.tsx 的顶部横栏内渲染（与原生红绿灯同一栏），
          此处不再渲染，导航直接从侧边栏顶部开始。 */}

      {/* 固定入口：概览（全局视图，不属于任何 Agent）已移至底部与设置并排 */}

      <nav className="scrollbar-visible relative z-10 flex-1 space-y-0.5 overflow-y-auto p-2">
        {orderedApps.map((app, index) => {
          const isActive = app === activeApp;
          const label = t(`apps.${app}`);
          // 已在最顶的项无需再置顶，不显示按钮
          const isFirst = index === 0;
          return (
            <div key={app} className="group relative">
              <button
                type="button"
                onClick={() => onSwitch(app)}
                title={label}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-10 w-full items-center rounded-lg transition-all duration-150",
                  collapsed ? "justify-center px-0" : "gap-3 pl-3 pr-8",
                  isActive
                    ? "bg-primary/10 font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {isActive &&
                  (collapsed ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary shadow-sm"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary/80 shadow-sm"
                    />
                  ))}
                <AppGlyph app={app} isActive={isActive} />
                {!collapsed && <span className="truncate text-sm">{label}</span>}
              </button>
              {!collapsed && !isFirst && (
                <button
                  type="button"
                  onClick={() => pinToTop(app)}
                  title={t("sidebar.pin")}
                  aria-label={t("sidebar.pin")}
                  className={cn(
                    "absolute right-0.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md",
                    "text-muted-foreground opacity-0 transition-opacity duration-150",
                    "hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100",
                    "group-hover:opacity-100",
                  )}
                >
                  <ArrowUpToLine size={14} />
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {/* 底部固定入口：设置（左）+ 概览（右）并排 */}
      <div
        className={cn(
          "relative z-10 flex shrink-0",
          collapsed ? "gap-0.5 p-1" : "gap-1 p-2",
        )}
      >
        <button
          type="button"
          onClick={onOpenSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
          aria-current={settingsActive ? "page" : undefined}
          className={cn(
            "flex h-10 min-w-0 flex-1 items-center rounded-lg transition-colors duration-150",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
            settingsActive
              ? "bg-primary/10 font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <Settings size={18} className="shrink-0" />
          {!collapsed && (
            <span className="truncate text-sm">{t("common.settings")}</span>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenHome}
          title={t("home.title")}
          aria-label={t("home.title")}
          aria-current={homeActive ? "page" : undefined}
          className={cn(
            "flex h-10 min-w-0 flex-1 items-center rounded-lg transition-colors duration-150",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
            homeActive
              ? "bg-primary/10 font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <OverviewIcon size={18} className="shrink-0" />
          {!collapsed && (
            <span className="truncate text-sm">{t("home.title")}</span>
          )}
        </button>
      </div>
    </aside>
  );
}
