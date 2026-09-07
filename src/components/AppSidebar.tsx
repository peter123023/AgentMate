import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpToLine,
  ChevronsLeft,
  ChevronsRight,
  Settings,
} from "lucide-react";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { cn } from "@/lib/utils";
import { AppGlyph } from "@/components/AppSwitcher";
import { APP_IDS } from "@/config/appConfig";
import {
  playTypeClick,
  tickVibrate,
  warmupAudioFeedback,
} from "@/lib/typewriterFeedback";

const COLLAPSE_STORAGE_KEY = "model-board-sidebar-collapsed";
const PINNED_APPS_STORAGE_KEY = "model-board-sidebar-pinned-apps";

// 打字/擦除逐字间隔；侧边栏宽度过渡时长 = 字数 × 间隔，保证两者同步
const TYPE_INTERVAL_MS = 45;
const ERASE_INTERVAL_MS = 100;

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

  // 品牌标题打字机效果：展开时逐字打出，收起时逐字收回
  const title = t("app.title");
  const [visibleChars, setVisibleChars] = useState(() =>
    collapsed ? 0 : title.length,
  );

  useEffect(() => {
    const target = collapsed ? 0 : title.length;
    const interval = window.setInterval(
      () => {
        setVisibleChars((prev) => {
          const next = collapsed
            ? Math.max(target, prev - 1)
            : Math.min(target, prev + 1);
          if (next !== prev) {
            playTypeClick();
            tickVibrate();
          }
          if (next === target) window.clearInterval(interval);
          return next;
        });
      },
      collapsed ? ERASE_INTERVAL_MS : TYPE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [collapsed, title]);

  // 宽度过渡时长与字母动画总时长一致，展开/收起时两者同步进行
  const widthTransitionMs = title.length * (collapsed ? ERASE_INTERVAL_MS : TYPE_INTERVAL_MS);

  // 箭头图标方向延迟切换：等字母动画和宽度动画到位后才翻转方向
  const [iconCollapsed, setIconCollapsed] = useState(collapsed);

  useEffect(() => {
    const timer = window.setTimeout(() => setIconCollapsed(collapsed), widthTransitionMs);
    return () => window.clearTimeout(timer);
  }, [collapsed, widthTransitionMs]);

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
    // 打字声由 interval 回调播放（不在手势栈内），需在点击时预热
    // AudioContext，否则 WebView 自动播放策略可能使其保持 suspended（静音）
    warmupAudioFeedback();
  };

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
        "flex shrink-0 flex-col border-r border-border bg-background/60",
        "transition-[width] ease-in-out",
        collapsed ? "w-12" : "w-48",
      )}
      style={{ transitionDuration: `${widthTransitionMs}ms` }}
    >
      {/* 顶部：品牌标题（水平居中） + 收起按钮（右侧），始终单行 */}
      <div className="relative flex h-12 shrink-0 items-center justify-end border-b border-border px-2">
        <div className="pointer-events-none absolute inset-y-0 left-0 right-8 flex items-center justify-center overflow-hidden">
          <span
            className="truncate text-base font-bold"
            aria-label={title}
          >
            {title.slice(0, visibleChars)}
          </span>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={!collapsed}
          title={iconCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-label={iconCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground",
            "transition-colors duration-150 hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {iconCollapsed ? (
            <ChevronsRight size={18} className="shrink-0" />
          ) : (
            <ChevronsLeft size={18} className="shrink-0" />
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
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
                  "flex h-10 w-full items-center rounded-lg transition-colors duration-150",
                  collapsed ? "justify-center px-0" : "gap-3 pl-3 pr-8",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
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
