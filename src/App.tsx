import { useEffect, useMemo, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  ArrowLeft,
  Minus,
  Maximize2,
  Minimize2,
  X,
  Brain,
  History,
  BarChart2,
  Download,
  FolderArchive,
  Search,
  FolderOpen,
  KeyRound,
  Shield,
  Cpu,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentNotificationSetting, Provider, VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import {
  proxyKeys,
  useProvidersQuery,
  useSaveSettingsMutation,
  useSettingsQuery,
} from "@/lib/query";
import {
  piApi,
  providersApi,
  settingsApi,
  type AppId,
  type ProviderSwitchEvent,
} from "@/lib/api";
import { checkAllEnvConflicts, checkEnvConflicts } from "@/lib/api/env";
import { useProviderActions } from "@/hooks/useProviderActions";
import { openclawKeys, useOpenClawHealth } from "@/hooks/useOpenClaw";
import { hermesKeys, useOpenHermesWebUI } from "@/hooks/useHermes";
import { hermesApi } from "@/lib/api/hermes";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useLastValidValue } from "@/hooks/useLastValidValue";
import { useScanUnmanagedSkills } from "@/hooks/useSkills";
import {
  extractErrorMessage,
  translatePiProviderMutationError,
} from "@/utils/errorUtils";
import { isTextEditableTarget } from "@/utils/domUtils";
import { deepClone } from "@/utils/deepClone";
import { cn } from "@/lib/utils";
import {
  isLinux,
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
} from "@/lib/platform";
import {
  AppSidebar,
  ERASE_INTERVAL_MS,
  SIDEBAR_EXPANDED_WIDTH,
  TYPE_INTERVAL_MS,
} from "@/components/AppSidebar";
import {
  playTypeClick,
  tickVibrate,
  warmupAudioFeedback,
} from "@/lib/typewriterFeedback";
import {
  SkillIcon,
  PromptIcon,
  SessionIcon,
} from "@/components/ContentIcons";
import { HomeDashboard } from "@/components/home/HomeDashboard";
import { ToolInstallStatus } from "@/components/providers/ToolInstallStatus";
import {
  AgentNotificationSettings,
  DEFAULT_AGENT_NOTIFICATION,
} from "@/components/sessions/AgentNotificationSettings";
import { getProviderNotifyColor } from "@/components/sessions/utils";
import { ProfileSwitcher } from "@/components/profiles/ProfileSwitcher";
import { ProviderList } from "@/components/providers/ProviderList";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { UpdateBadge } from "@/components/UpdateBadge";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";
import { ClaudeDesktopRouteToggle } from "@/components/proxy/ClaudeDesktopRouteToggle";
import { FailoverToggle } from "@/components/proxy/FailoverToggle";
import { RoutingActivationBrand } from "@/components/proxy/RoutingActivationBrand";
import UsageScriptModal from "@/components/UsageScriptModal";
import UnifiedMcpPanel from "@/components/mcp/UnifiedMcpPanel";
import PromptPanel, {
  type PromptPanelHandle,
  type PromptPrimaryAction,
} from "@/components/prompts/PromptPanel";
import {
  SkillsPage,
  getSkillsPageHeaderActions,
  type SkillsPageSource,
} from "@/components/skills/SkillsPage";
import UnifiedSkillsPanel, {
  type SkillsCheckUpdatesState,
} from "@/components/skills/UnifiedSkillsPanel";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { AgentsPanel } from "@/components/agents/AgentsPanel";
import { UniversalProviderPanel } from "@/components/universal";
import { McpIcon } from "@/components/BrandIcons";
import { Button } from "@/components/ui/button";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import {
  useDisableCurrentOmo,
  useDisableCurrentOmoSlim,
} from "@/lib/query/omo";
import { invalidatePiProviderCaches, usePiCurrentState } from "@/lib/query/pi";
import WorkspaceFilesPanel from "@/components/workspace/WorkspaceFilesPanel";
import EnvPanel from "@/components/openclaw/EnvPanel";
import ToolsPanel from "@/components/openclaw/ToolsPanel";
import AgentsDefaultsPanel from "@/components/openclaw/AgentsDefaultsPanel";
import OpenClawHealthBanner from "@/components/openclaw/OpenClawHealthBanner";
import HermesMemoryPanel from "@/components/hermes/HermesMemoryPanel";
import {
  APP_IDS,
  DEFAULT_VISIBLE_APPS,
  isProxyAppId,
} from "@/config/appConfig";

type View =
  | "home"
  | "providers"
  | "settings"
  | "prompts"
  | "skills"
  | "skillsDiscovery"
  | "mcp"
  | "agents"
  | "universal"
  | "sessions"
  | "workspace"
  | "openclawEnv"
  | "openclawTools"
  | "openclawAgents"
  | "hermesMemory";

interface SyncStatusUpdatedPayload {
  source?: string;
  status?: string;
  error?: string;
}

// macOS 走 tauri.conf.json 的 titleBarStyle:"Overlay" + app.macOSPrivateApi:true
// （Cargo.toml 需给 tauri 加 "macos-private-api" feature 并重编 Rust 才生效）。
// 实测（Retina 2x 截图逐像素 + AppleScript 窗口 position 定标）：
//   webview 铺满全窗，页面原点 = 窗口 y 0；
//   原生红绿灯悬浮在页面 y≈9~22.5（中心≈15.75）、x≈20~72。
// 顶部横栏（根容器 flex-col 第一行）高 30：
//   品牌行（标题 + 收起按钮，无 Logo）绝对定位在横栏内**水平居中**，
//   垂直居中 → 中心 15 ≈ 红绿灯中心 15.75（同一行）；
//   底边 border-b（y=30）= 全窗唯一分割线，紧贴红绿灯行底部。
//   品牌行不参与左/右段 flex 流，inset-0 + justify-center 覆盖整条横栏居中；
//   容器与标题 pointer-events-none（拖拽穿透下层），macOS 红绿灯在其左，
//   正常窗口宽度下互不重叠。
const TOP_BAR_HEIGHT = 30; // px（全平台统一；Windows 系统自带边框不受影响）
const HEADER_HEIGHT = 64; // px

const STORAGE_KEY = "agentmate-last-app";
const getInitialApp = (): AppId => {
  const saved = localStorage.getItem(STORAGE_KEY) as AppId | null;
  if (saved && APP_IDS.includes(saved)) {
    return saved;
  }
  return "claude";
};

const VIEW_STORAGE_KEY = "agentmate-last-view";
const VALID_VIEWS: View[] = [
  "home",
  "providers",
  "settings",
  "prompts",
  "skills",
  "skillsDiscovery",
  "mcp",
  "agents",
  "universal",
  "sessions",
  "workspace",
  "openclawEnv",
  "openclawTools",
  "openclawAgents",
  "hermesMemory",
];

const getInitialView = (): View => {
  const saved = localStorage.getItem(VIEW_STORAGE_KEY) as View | null;
  if (saved && VALID_VIEWS.includes(saved)) {
    return saved;
  }
  return "providers";
};

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeApp, setActiveApp] = useState<AppId>(getInitialApp);
  const sharedFeatureApp: AppId =
    activeApp === "claude-desktop" ? "claude" : activeApp;
  const [currentView, setCurrentView] = useState<View>(getInitialView);
  const [skillsDiscoverySource, setSkillsDiscoverySource] =
    useState<SkillsPageSource>("repos");
  const [settingsDefaultTab, setSettingsDefaultTab] = useState("general");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [mcpManagementBusy, setMcpManagementBusy] = useState(false);
  const [skillsManagementBusy, setSkillsManagementBusy] = useState(false);
  const [skillsNavigationBusy, setSkillsNavigationBusy] = useState(false);
  const [promptManagementBusy, setPromptManagementBusy] = useState(false);
  const [promptNavigationBusy, setPromptNavigationBusy] = useState(false);
  const [skillsCheckUpdatesState, setSkillsCheckUpdatesState] =
    useState<SkillsCheckUpdatesState>({
      isChecking: false,
      hasSkills: false,
    });

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, currentView);
  }, [currentView]);

  const { data: settingsData } = useSettingsQuery();
  const saveSettingsMutation = useSaveSettingsMutation();
  const useAppWindowControls =
    isLinux() && (settingsData?.useAppWindowControls ?? false);
  // 侧边栏当前宽度，用于让顶部横栏的底色分段与左右两栏对齐
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_EXPANDED_WIDTH);
  // 侧边栏收起状态提升到这里：顶部横栏的品牌行与侧边栏本体需要共享同一状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("agentmate-sidebar-collapsed") === "true",
  );
  const toggleSidebarCollapsed = () => {
    // 打字声由 interval 回调播放（不在手势栈内），需在点击时预热
    // AudioContext，否则 WebView 自动播放策略可能使其保持 suspended（静音）
    warmupAudioFeedback();
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem("agentmate-sidebar-collapsed", String(next));
      return next;
    });
  };
  // 品牌标题打字机：展开逐字打出 / 收起逐字收回，
  // 间隔与侧边栏宽度动画（字数 × 同一组间隔）保持一致，两处同步起止。
  const brandTitle = t("app.title");
  const [brandVisibleChars, setBrandVisibleChars] = useState(() =>
    sidebarCollapsed ? 0 : brandTitle.length,
  );
  useEffect(() => {
    const target = sidebarCollapsed ? 0 : brandTitle.length;
    const timer = window.setInterval(
      () =>
        setBrandVisibleChars((prev) => {
          const next = sidebarCollapsed
            ? Math.max(target, prev - 1)
            : Math.min(target, prev + 1);
          // 打字/擦除逐字音效：与字符推进 1:1（从旧侧边栏实现迁移，勿再丢）
          if (next !== prev) {
            playTypeClick();
            tickVibrate();
          }
          if (next === target) window.clearInterval(timer);
          return next;
        }),
      sidebarCollapsed ? ERASE_INTERVAL_MS : TYPE_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [sidebarCollapsed, brandTitle]);
  // 侧边栏栏宽过渡时长：与 AppSidebar 内部算法一致，横栏左段底色随之同步
  const sidebarWidthTransitionMs =
    brandTitle.length * (sidebarCollapsed ? ERASE_INTERVAL_MS : TYPE_INTERVAL_MS);
  const visibleApps = useMemo<VisibleApps>(
    () => ({
      ...DEFAULT_VISIBLE_APPS,
      ...settingsData?.visibleApps,
    }),
    [settingsData?.visibleApps],
  );

  const getFirstVisibleApp = (): AppId => {
    return APP_IDS.find((app) => visibleApps[app]) ?? "claude";
  };

  useEffect(() => {
    if (!visibleApps[activeApp]) {
      const first = getFirstVisibleApp();
      // 回退时同步存储，避免下次刷新又落回已隐藏的 App
      localStorage.setItem(STORAGE_KEY, first);
      setActiveApp(first);
    }
  }, [visibleApps, activeApp]);

  // ---- 各功能入口的能力开关（唯一事实来源）----
  // 历史坑：这些能力曾在「顶栏胶囊开关」「视图回退 effect」「按钮渲染」三处
  // 各自硬编码 app id 列表，给某 App 新增能力时极易漏改（WorkBuddy 会话
  // 就连续踩了两次）。现统一在此定义，其余位置一律复用这些变量。
  const hasSkillsSupport =
    sharedFeatureApp !== "openclaw" && sharedFeatureApp !== "workbuddy";
  const hasPromptSupport = sharedFeatureApp !== "workbuddy";
  // 会话：白名单制（需后端有对应 session provider 解析器）
  const hasSessionSupport =
    sharedFeatureApp === "claude" ||
    sharedFeatureApp === "codex" ||
    sharedFeatureApp === "grokbuild" ||
    sharedFeatureApp === "opencode" ||
    sharedFeatureApp === "openclaw" ||
    sharedFeatureApp === "gemini" ||
    sharedFeatureApp === "hermes" ||
    sharedFeatureApp === "pi" ||
    sharedFeatureApp === "workbuddy" ||
    sharedFeatureApp === "deepseek-harness";
  const hasMcpSupport =
    sharedFeatureApp !== "pi" && sharedFeatureApp !== "workbuddy";
  // 顶栏功能入口胶囊是否渲染：只要任一能力可用就渲染，不留空灰块
  const hasFeatureEntries =
    activeApp === "hermes" ||
    activeApp === "openclaw" ||
    hasSkillsSupport ||
    hasPromptSupport ||
    hasSessionSupport ||
    hasMcpSupport;

  // Fallback from sessions view when switching to an app without session support
  useEffect(() => {
    if (
      currentView === "mcp" &&
      (sharedFeatureApp === "pi" || sharedFeatureApp === "workbuddy")
    ) {
      setCurrentView("providers");
      return;
    }
    if (
      (currentView === "skills" ||
        currentView === "skillsDiscovery" ||
        currentView === "prompts") &&
      sharedFeatureApp === "workbuddy"
    ) {
      setCurrentView("providers");
      return;
    }
    if (currentView === "sessions" && !hasSessionSupport) {
      setCurrentView("providers");
    }
  }, [sharedFeatureApp, currentView, hasSessionSupport]);

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [usageProvider, setUsageProvider] = useState<Provider | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    provider: Provider;
    action: "remove" | "delete";
  } | null>(null);
  const [envConflicts, setEnvConflicts] = useState<EnvConflict[]>([]);
  const [showEnvBanner, setShowEnvBanner] = useState(false);

  const effectiveEditingProvider = useLastValidValue(editingProvider);
  const effectiveUsageProvider = useLastValidValue(usageProvider);

  useUsageCacheBridge();

  const promptPanelRef = useRef<PromptPanelHandle>(null);
  const [promptPrimaryAction, setPromptPrimaryAction] =
    useState<PromptPrimaryAction>("prompt");
  const mcpPanelRef = useRef<any>(null);
  const skillsPageRef = useRef<any>(null);
  const unifiedSkillsPanelRef = useRef<any>(null);
  // 订阅未管理 Skill 的共享缓存（实际扫描由 UnifiedSkillsPanel 进入页面时触发）。
  // 这里 enabled 默认 false，仅用于「导入」按钮的绿点提示，不主动发起扫描。
  const { data: unmanagedSkills } = useScanUnmanagedSkills();
  const hasUnmanagedSkills = (unmanagedSkills?.length ?? 0) > 0;
  const addActionButtonClass =
    "bg-orange-500 hover:bg-orange-600 dark:bg-orange-500 dark:hover:bg-orange-600 text-white shadow-lg shadow-orange-500/30 dark:shadow-orange-500/40 rounded-full w-8 h-8";

  const {
    isRunning: isProxyRunning,
    takeoverStatus,
    status: proxyStatus,
  } = useProxyStatus();
  const proxyAppId = isProxyAppId(activeApp) ? activeApp : null;
  const currentAppUsesProxy =
    proxyAppId !== null || activeApp === "claude-desktop";
  const isCurrentAppTakeoverActive = proxyAppId
    ? takeoverStatus?.[proxyAppId] || false
    : false;
  const activeProviderId = useMemo(() => {
    if (!proxyAppId) return undefined;
    const target = proxyStatus?.active_targets?.find(
      (t) => t.app_type === proxyAppId,
    );
    return target?.provider_id;
  }, [proxyStatus?.active_targets, proxyAppId]);

  const { data, isLoading, refetch } = useProvidersQuery(activeApp, {
    isProxyRunning: currentAppUsesProxy && isProxyRunning,
  });
  const { data: piCurrentState } = usePiCurrentState(activeApp === "pi");
  const providers = useMemo(() => data?.providers ?? {}, [data]);
  const currentProviderId = data?.currentProviderId ?? "";
  const isOpenClawView =
    activeApp === "openclaw" &&
    (currentView === "providers" ||
      currentView === "workspace" ||
      currentView === "sessions" ||
      currentView === "openclawEnv" ||
      currentView === "openclawTools" ||
      currentView === "openclawAgents");
  const { data: openclawHealthWarnings = [] } =
    useOpenClawHealth(isOpenClawView);

  const {
    addProvider,
    updateProvider,
    switchProvider,
    deleteProvider,
    saveUsageScript,
    setAsDefaultModel,
  } = useProviderActions(
    activeApp,
    currentAppUsesProxy && isProxyRunning,
    isProxyRunning && isCurrentAppTakeoverActive,
  );
  const handleEnablePiProvider = async (provider: Provider) => {
    try {
      await providersApi.switch(provider.id, "pi");
      await invalidatePiProviderCaches(queryClient);
      await providersApi.updateTrayMenu().catch((error) => {
        console.error(
          "Failed to update tray menu after enabling Pi provider",
          error,
        );
      });
      toast.success(
        t("pi.provider.enabled", {
          defaultValue: "已在 Pi 中启用",
        }),
        { closeButton: true },
      );
    } catch (error) {
      const detail = extractErrorMessage(error);
      toast.error(
        t("pi.provider.enableFailed", {
          defaultValue: "无法在 Pi 中启用此供应商",
        }),
        {
          description:
            translatePiProviderMutationError(detail, t) || detail || undefined,
          closeButton: true,
        },
      );
    }
  };

  const disableOmoMutation = useDisableCurrentOmo();
  const handleDisableOmo = () => {
    disableOmoMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("omo.disabled", { defaultValue: "OMO 已停用" }));
      },
      onError: (error: Error) => {
        toast.error(
          t("omo.disableFailed", {
            defaultValue: "停用 OMO 失败: {{error}}",
            error: extractErrorMessage(error),
          }),
        );
      },
    });
  };

  const disableOmoSlimMutation = useDisableCurrentOmoSlim();
  const handleDisableOmoSlim = () => {
    disableOmoSlimMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("omo.disabled", { defaultValue: "OMO 已停用" }));
      },
      onError: (error: Error) => {
        toast.error(
          t("omo.disableFailed", {
            defaultValue: "停用 OMO 失败: {{error}}",
            error: extractErrorMessage(error),
          }),
        );
      },
    });
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;

    const setupListener = async () => {
      try {
        const off = await providersApi.onSwitched(
          async (event: ProviderSwitchEvent) => {
            if (event.appType === activeApp) {
              await refetch();
            }
            if (event.appType === "pi") {
              await invalidatePiProviderCaches(queryClient);
            }
          },
        );
        if (!active) {
          off();
          return;
        }
        unsubscribe = off;
      } catch (error) {
        console.error("[App] Failed to subscribe provider switch event", error);
      }
    };

    void setupListener();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [activeApp, queryClient, refetch]);

  useTauriEvent("universal-provider-synced", async () => {
    await queryClient.invalidateQueries({ queryKey: ["providers"] });
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to update tray menu", error);
    }
  });

  // 应用项目后刷新相关缓存（providers 由既有 provider-switched 监听承接；
  // proxy 状态由后端直接改 DB，不走 mutation，必须显式刷新）
  useTauriEvent("profile-applied", async () => {
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    await queryClient.invalidateQueries({
      queryKey: proxyKeys.takeoverStatus,
    });
    await queryClient.invalidateQueries({ queryKey: proxyKeys.status });
    await queryClient.invalidateQueries({
      queryKey: ["providers", "claude-desktop"],
    });
  });

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "webdav-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.webdavSync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "s3-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.s3Sync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<{ appType: string; providerName: string }>(
    "proxy-official-warning",
    (payload) => {
      toast.warning(
        t("notifications.proxyOfficialWarning", {
          name: payload.providerName,
          defaultValue: `当前供应商 ${payload.providerName} 是官方供应商，建议切换到第三方供应商后再使用代理接管`,
        }),
        { duration: 8000 },
      );
    },
  );

  useEffect(() => {
    let active = true;
    let unlistenResize: (() => void) | undefined;

    const setupWindowStateSync = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const syncWindowMaximizedState = async () => {
          const maximized = await currentWindow.isMaximized();
          if (active) {
            setIsWindowMaximized(maximized);
          }
        };

        await syncWindowMaximizedState();
        unlistenResize = await currentWindow.onResized(() => {
          void syncWindowMaximizedState();
        });
      } catch (error) {
        console.error("[App] Failed to sync window maximized state", error);
      }
    };

    void setupWindowStateSync();
    return () => {
      active = false;
      unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    // 仅 Linux 需要：该平台用系统窗口按钮替换自绘控件，通过 setDecorations 切换。
    // macOS 绝不可调用——窗口由 titleBarStyle:"Overlay" 静态配置，原生红绿灯以悬浮层
    // 绘制在网页之上，运行期 setDecorations 会破坏 Overlay 模式，导致交通灯按钮从无障碍树中消失。
    // Windows 的 dragBarHeight 为 0，也没有装饰切换需求。
    if (!settingsData || !useAppWindowControls) return;

    const syncWindowDecorations = async () => {
      try {
        await getCurrentWindow().setDecorations(!useAppWindowControls);
      } catch (error) {
        console.error("[App] Failed to update window decorations", error);
      }
    };

    void syncWindowDecorations();
  }, [useAppWindowControls, settingsData]);

  useEffect(() => {
    const checkEnvOnStartup = async () => {
      try {
        const allConflicts = await checkAllEnvConflicts();
        const flatConflicts = Object.values(allConflicts).flat();

        if (flatConflicts.length > 0) {
          setEnvConflicts(flatConflicts);
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on startup:",
          error,
        );
      }
    };

    checkEnvOnStartup();
  }, []);

  useEffect(() => {
    const checkMigration = async () => {
      try {
        const migrated = await invoke<boolean>("get_migration_result");
        if (migrated) {
          toast.success(
            t("migration.success", { defaultValue: "配置迁移成功" }),
            { closeButton: true },
          );
        }
      } catch (error) {
        console.error("[App] Failed to check migration result:", error);
      }
    };

    checkMigration();
  }, [t]);

  useEffect(() => {
    const checkSkillsMigration = async () => {
      try {
        const result = await invoke<{ count: number; error?: string } | null>(
          "get_skills_migration_result",
        );
        if (result?.error) {
          toast.error(t("migration.skillsFailed"), {
            description: t("migration.skillsFailedDescription"),
            closeButton: true,
          });
          console.error("[App] Skills SSOT migration failed:", result.error);
          return;
        }
        if (result && result.count > 0) {
          toast.success(t("migration.skillsSuccess", { count: result.count }), {
            closeButton: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["skills"] });
        }
      } catch (error) {
        console.error("[App] Failed to check skills migration result:", error);
      }
    };

    checkSkillsMigration();
  }, [t, queryClient]);

  useEffect(() => {
    const checkEnvOnSwitch = async () => {
      try {
        const conflicts = await checkEnvConflicts(activeApp);

        if (conflicts.length > 0) {
          setEnvConflicts((prev) => {
            const existingKeys = new Set(
              prev.map((c) => `${c.varName}:${c.sourcePath}`),
            );
            const newConflicts = conflicts.filter(
              (c) => !existingKeys.has(`${c.varName}:${c.sourcePath}`),
            );
            return [...prev, ...newConflicts];
          });
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on app switch:",
          error,
        );
      }
    };

    checkEnvOnSwitch();
  }, [activeApp]);

  const currentViewRef = useRef(currentView);
  const managementBusy =
    mcpManagementBusy || skillsNavigationBusy || promptNavigationBusy;
  const managementBusyRef = useRef(false);
  managementBusyRef.current = managementBusy;

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        if (managementBusyRef.current) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        setCurrentView("settings");
        return;
      }

      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (document.body.style.overflow === "hidden") return;

      const view = currentViewRef.current;
      if (view === "providers") return;
      if (managementBusyRef.current) return;

      if (isTextEditableTarget(event.target)) return;

      event.preventDefault();
      setCurrentView(view === "skillsDiscovery" ? "skills" : "providers");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const [launchDashboardOpen, setLaunchDashboardOpen] = useState(false);
  const openHermesWebUI = useOpenHermesWebUI(() =>
    setLaunchDashboardOpen(true),
  );

  const handleOpenWebsite = async (url: string) => {
    try {
      await settingsApi.openExternal(url);
    } catch (error) {
      const detail =
        extractErrorMessage(error) ||
        t("notifications.openLinkFailed", {
          defaultValue: "链接打开失败",
        });
      toast.error(detail);
    }
  };

  const handleEditProvider = async ({
    provider,
    originalId,
  }: {
    provider: Provider;
    originalId?: string;
  }) => {
    await updateProvider(provider, originalId);
    setEditingProvider(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    const { provider, action } = confirmAction;

    if (action === "remove") {
      // Remove from live config only (for additive mode apps like OpenCode/OpenClaw)
      // Does NOT delete from database - provider remains in the list
      try {
        await providersApi.removeFromLiveConfig(provider.id, activeApp);
      } catch (error) {
        const detail = extractErrorMessage(error);
        const description =
          activeApp === "pi"
            ? translatePiProviderMutationError(detail, t) || detail
            : detail;
        if (activeApp === "pi") {
          void invalidatePiProviderCaches(queryClient).catch(() => undefined);
        }
        toast.error(t("notifications.removeFromConfigFailed"), {
          description: description || t("common.unknown"),
          closeButton: true,
        });
        return;
      }
      if (activeApp === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
      // Invalidate queries to refresh the isInConfig state
      if (activeApp === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["opencodeLiveProviderIds"],
        });
      } else if (activeApp === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.liveProviderIds,
        });
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      } else if (activeApp === "hermes") {
        await queryClient.invalidateQueries({
          queryKey: hermesKeys.liveProviderIds,
        });
      } else if (activeApp === "workbuddy") {
        await queryClient.invalidateQueries({
          queryKey: ["workbuddyLiveProviderIds"],
        });
      }
      toast.success(
        activeApp === "pi"
          ? t("pi.provider.removed", {
              defaultValue: "已从 Pi 移除",
            })
          : t("notifications.removeFromConfigSuccess", {
              defaultValue: "已从配置移除",
            }),
        { closeButton: true },
      );
    } else {
      await deleteProvider(provider.id);
    }
    setConfirmAction(null);
  };

  const generateUniqueProviderCopyKey = (
    originalKey: string,
    existingKeys: string[],
  ): string => {
    const baseKey = `${originalKey}-copy`;

    if (!existingKeys.includes(baseKey)) {
      return baseKey;
    }

    let counter = 2;
    while (existingKeys.includes(`${baseKey}-${counter}`)) {
      counter++;
    }
    return `${baseKey}-${counter}`;
  };

  const handleDuplicateProvider = async (provider: Provider) => {
    const newSortIndex =
      provider.sortIndex !== undefined ? provider.sortIndex + 1 : undefined;

    const duplicatedProvider: Omit<Provider, "id" | "createdAt"> & {
      providerKey?: string;
      addToLive?: boolean;
    } = {
      name: `${provider.name} copy`,
      settingsConfig: deepClone(provider.settingsConfig),
      websiteUrl: provider.websiteUrl,
      category: provider.category,
      sortIndex: newSortIndex, // 复制原 sortIndex + 1
      meta: provider.meta ? deepClone(provider.meta) : undefined,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };

    if (
      activeApp === "opencode" ||
      activeApp === "openclaw" ||
      activeApp === "hermes" ||
      activeApp === "pi" ||
      activeApp === "workbuddy"
    ) {
      let liveProviderIds: string[] = [];
      try {
        liveProviderIds =
          activeApp === "opencode"
            ? await queryClient.ensureQueryData({
                queryKey: ["opencodeLiveProviderIds"],
                queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
              })
            : activeApp === "openclaw"
              ? await queryClient.ensureQueryData({
                  queryKey: openclawKeys.liveProviderIds,
                  queryFn: () => providersApi.getOpenClawLiveProviderIds(),
                })
              : activeApp === "hermes"
                ? await queryClient.ensureQueryData({
                    queryKey: hermesKeys.liveProviderIds,
                    queryFn: () => providersApi.getHermesLiveProviderIds(),
                  })
                : activeApp === "workbuddy"
                  ? await queryClient.ensureQueryData({
                      queryKey: ["workbuddyLiveProviderIds"],
                      queryFn: () => providersApi.getWorkBuddyLiveProviderIds(),
                    })
                  : (
                      await queryClient.ensureQueryData({
                        queryKey: ["pi", "currentState"],
                        queryFn: () => piApi.getCurrentState(),
                      })
                    ).enabledProviderIds;
      } catch (error) {
        console.error(
          "[App] Failed to load live provider IDs for duplication",
          error,
        );
        const errorMessage = extractErrorMessage(error);
        toast.error(
          t("provider.duplicateLiveIdsLoadFailed", {
            defaultValue: "读取配置中的供应商标识失败，请先修复配置后再试",
          }) + (errorMessage ? `: ${errorMessage}` : ""),
        );
        return;
      }
      const existingKeys = Array.from(
        new Set([...Object.keys(providers), ...liveProviderIds]),
      );
      duplicatedProvider.providerKey = generateUniqueProviderCopyKey(
        provider.id,
        existingKeys,
      );
      duplicatedProvider.addToLive = false;
    }

    if (provider.sortIndex !== undefined) {
      const updates = Object.values(providers)
        .filter(
          (p) =>
            p.sortIndex !== undefined &&
            p.sortIndex >= newSortIndex! &&
            p.id !== provider.id,
        )
        .map((p) => ({
          id: p.id,
          sortIndex: p.sortIndex! + 1,
        }));

      if (updates.length > 0) {
        try {
          await providersApi.updateSortOrder(updates, activeApp);
        } catch (error) {
          console.error("[App] Failed to update sort order", error);
          toast.error(
            t("provider.sortUpdateFailed", {
              defaultValue: "排序更新失败",
            }),
          );
          return; // 如果排序更新失败，不继续添加
        }
      }
    }

    await addProvider(duplicatedProvider);
  };

  const confirmActionMessage = useMemo(() => {
    if (!confirmAction) return "";

    const message =
      confirmAction.action === "remove"
        ? t("confirm.removeProviderMessage", {
            name: confirmAction.provider.name,
          })
        : t("confirm.deleteProviderMessage", {
            name: confirmAction.provider.name,
          });
    const isPiGlobalDefault =
      activeApp === "pi" &&
      piCurrentState?.defaultProviderId === confirmAction.provider.id;

    return isPiGlobalDefault
      ? `${message}\n\n${t("confirm.piDefaultProviderWarning")}`
      : message;
  }, [activeApp, confirmAction, piCurrentState?.defaultProviderId, t]);

  const handleOpenTerminal = async (provider: Provider) => {
    try {
      const selectedDir = await settingsApi.pickDirectory();
      if (!selectedDir) {
        return;
      }

      await providersApi.openTerminal(provider.id, activeApp, {
        cwd: selectedDir,
      });
      toast.success(
        t("provider.terminalOpened", {
          defaultValue: "终端已打开",
        }),
      );
    } catch (error) {
      console.error("[App] Failed to open terminal", error);
      const errorMessage = extractErrorMessage(error);
      toast.error(
        t("provider.terminalOpenFailed", {
          defaultValue: "打开终端失败",
        }) + (errorMessage ? `: ${errorMessage}` : ""),
      );
    }
  };

  const handleImportSuccess = async () => {
    try {
      await queryClient.invalidateQueries({
        queryKey: ["providers"],
        refetchType: "all",
      });
      await queryClient.refetchQueries({
        queryKey: ["providers"],
        type: "all",
      });
    } catch (error) {
      console.error("[App] Failed to refresh providers after import", error);
      await refetch();
    }
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to refresh tray menu", error);
    }
  };

  const notifyWindowControlError = (error: unknown) => {
    toast.error(
      t("notifications.windowControlFailed", {
        defaultValue: "窗口控制失败：{{error}}",
        error: extractErrorMessage(error),
      }),
    );
  };

  const handleWindowMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      console.error("[App] Failed to minimize window", error);
      notifyWindowControlError(error);
    }
  };

  // 更新某个 agent 的完成通知设置（开关/声音/颜色），即时持久化
  const updateAgentNotification = (
    providerId: string,
    next: AgentNotificationSetting,
  ) => {
    if (!settingsData) return;
    saveSettingsMutation.mutate({
      ...settingsData,
      agentNotifications: {
        ...(settingsData.agentNotifications ?? {}),
        [providerId]: next,
      },
    });
  };

  const handleWindowToggleMaximize = async () => {
    try {
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      setIsWindowMaximized(await currentWindow.isMaximized());
    } catch (error) {
      console.error("[App] Failed to toggle maximize", error);
      notifyWindowControlError(error);
    }
  };

  const handleWindowClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (error) {
      console.error("[App] Failed to close window", error);
      notifyWindowControlError(error);
    }
  };

  const handleOpenSkillsDiscovery = () => {
    setSkillsDiscoverySource("repos");
    setCurrentView("skillsDiscovery");
  };

  const renderContent = () => {
    const content = (() => {
      switch (currentView) {
        case "settings":
          return (
            <SettingsPage
              open={true}
              onOpenChange={() => setCurrentView("providers")}
              onImportSuccess={handleImportSuccess}
              defaultTab={settingsDefaultTab}
            />
          );
        case "prompts":
          return (
            <PromptPanel
              ref={promptPanelRef}
              open={true}
              onOpenChange={() => setCurrentView("providers")}
              appId={sharedFeatureApp}
              onInteractionBlockedChange={setPromptManagementBusy}
              onNavigationBlockedChange={setPromptNavigationBusy}
              onPrimaryActionChange={setPromptPrimaryAction}
            />
          );
        case "hermesMemory":
          return <HermesMemoryPanel />;
        case "skills":
          return (
            <UnifiedSkillsPanel
              ref={unifiedSkillsPanelRef}
              onOpenDiscovery={handleOpenSkillsDiscovery}
              onInteractionBlockedChange={setSkillsManagementBusy}
              onNavigationBlockedChange={setSkillsNavigationBusy}
              onCheckUpdatesStateChange={setSkillsCheckUpdatesState}
              currentApp={
                sharedFeatureApp === "openclaw" ? "claude" : sharedFeatureApp
              }
            />
          );
        case "skillsDiscovery":
          return (
            <SkillsPage
              ref={skillsPageRef}
              initialApp={
                sharedFeatureApp === "openclaw" ? "claude" : sharedFeatureApp
              }
              onSourceChange={setSkillsDiscoverySource}
            />
          );
        case "mcp":
          return (
            <UnifiedMcpPanel
              ref={mcpPanelRef}
              onOpenChange={() => setCurrentView("providers")}
              onInteractionBlockedChange={setMcpManagementBusy}
            />
          );
        case "agents":
          return (
            <AgentsPanel onOpenChange={() => setCurrentView("providers")} />
          );
        case "universal":
          return (
            <div className="px-6 pt-4">
              <UniversalProviderPanel />
            </div>
          );

        case "sessions":
          return (
            <SessionManagerPage
              key={sharedFeatureApp}
              appId={sharedFeatureApp}
            />
          );
        case "workspace":
          return <WorkspaceFilesPanel />;
        case "openclawEnv":
          return <EnvPanel />;
        case "openclawTools":
          return <ToolsPanel />;
        case "openclawAgents":
          return <AgentsDefaultsPanel />;
        case "home":
          return (
            <HomeDashboard
              onOpenUsage={() => {
                setSettingsDefaultTab("usage");
                setCurrentView("settings");
              }}
            />
          );
        default:
          return (
            <div className="px-6 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto overflow-x-hidden pb-12 px-1">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeApp}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="space-y-4"
                  >
                    <ProviderList
                      providers={providers}
                      currentProviderId={currentProviderId}
                      appId={activeApp}
                      isLoading={isLoading}
                      isProxyRunning={currentAppUsesProxy && isProxyRunning}
                      isProxyTakeover={
                        isProxyRunning && isCurrentAppTakeoverActive
                      }
                      activeProviderId={activeProviderId}
                      onSwitch={
                        activeApp === "pi"
                          ? handleEnablePiProvider
                          : switchProvider
                      }
                      onEdit={(provider) => {
                        setEditingProvider(provider);
                      }}
                      onDelete={(provider) =>
                        setConfirmAction({ provider, action: "delete" })
                      }
                      onRemoveFromConfig={
                        activeApp === "opencode" ||
                        activeApp === "openclaw" ||
                        activeApp === "hermes" ||
                        activeApp === "pi" ||
                        activeApp === "workbuddy"
                          ? (provider) =>
                              setConfirmAction({ provider, action: "remove" })
                          : undefined
                      }
                      onDisableOmo={
                        activeApp === "opencode" ? handleDisableOmo : undefined
                      }
                      onDisableOmoSlim={
                        activeApp === "opencode"
                          ? handleDisableOmoSlim
                          : undefined
                      }
                      onDuplicate={handleDuplicateProvider}
                      onConfigureUsage={setUsageProvider}
                      onOpenWebsite={handleOpenWebsite}
                      onOpenTerminal={
                        activeApp === "claude" ? handleOpenTerminal : undefined
                      }
                      onCreate={() => setIsAddOpen(true)}
                      onSetAsDefault={
                        activeApp === "openclaw"
                          ? setAsDefaultModel
                          : activeApp === "hermes"
                            ? switchProvider
                            : undefined
                      }
                    />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          );
      }
    })();

    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={currentView}
          className="flex-1 min-h-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground selection:bg-primary/30"
      // 纵向：第一行是顶部横栏（含原生红绿灯避让区 + 品牌行），第二行是
      // 侧边栏 + 主内容。全部处于同一坐标系，避免 fixed/负 margin 带来的偏移。
      style={{ overflowX: "hidden" } as any}
    >
      {/* 横栏处于文档流（根容器 flex-col 第一行），与下方两栏同一坐标系。
          全窗唯一的贯穿分割线 = 横栏自己的底边 border-b，勿再另加静态线。 */}
      {/* 横栏：根容器（flex-col）第一行，文档流，与下方两栏同一坐标系。
          全窗唯一的贯穿分割线 = 横栏自己的底边 border-b，勿再另加静态线。
          macOS：原生红绿灯悬浮在左段（侧边栏色带）上方，品牌行在右段左端
          与红绿灯同一行。Tauri 拖拽只认事件目标上的 data-tauri-drag-region。 */}
      <div
        className="relative z-[70] flex shrink-0 items-stretch border-b border-border"
        data-tauri-drag-region
        style={
          {
            WebkitAppRegion: "drag",
            // 横栏高度：品牌行与红绿灯同一行，底边线紧贴红绿灯行底部
            height: TOP_BAR_HEIGHT,
          } as any
        }
      >
        {/* 左段：侧边栏本色空带，宽度与侧边栏一致（同步过渡），红绿灯悬浮其上 */}
        <div
          className="shrink-0 bg-sidebar transition-[width] ease-in-out"
          data-tauri-drag-region
          style={{
            width: sidebarWidth,
            transitionDuration: `${sidebarWidthTransitionMs}ms`,
          }}
        />
        {/* 右段：主内容本色。窗口控制按钮（Linux 自绘控件）靠右，
            品牌行见下方绝对定位层（不占 flex 流）。 */}
        <div
          className="flex min-w-0 flex-1 items-center justify-end bg-background pr-2"
          data-tauri-drag-region
        >
          {useAppWindowControls && (
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as any}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowMinimize()}
                title={t("header.windowMinimize")}
                className="h-7 w-7"
              >
                <Minus className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowToggleMaximize()}
                title={
                  isWindowMaximized
                    ? t("header.windowRestore")
                    : t("header.windowMaximize")
                }
                className="h-7 w-7"
              >
                {isWindowMaximized ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowClose()}
                title={t("header.windowClose")}
                className="h-7 w-7 hover:bg-red-500/15 hover:text-red-500"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            )}
          </div>
          {/* 品牌行：绝对定位覆盖整条横栏、**水平居中**（用户指定），
              与红绿灯同一行（垂直居中，中心 15）；macOS 红绿灯在最左，
              正常窗口宽度下与居中标题互不重叠。
              容器与标题均 pointer-events-none → 拖拽穿透到下层色带/右段；
              仅收起按钮可交互。标题带打字机动画（brandVisibleChars）。 */}
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2"
          >
            <span
              className="pointer-events-none truncate text-base font-bold tracking-tight"
              aria-label={brandTitle}
            >
              {brandTitle.slice(0, brandVisibleChars)}
            </span>
            <button
              type="button"
              onClick={toggleSidebarCollapsed}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              className="pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground"
            >
              {sidebarCollapsed ? (
                <ChevronsRight size={16} className="shrink-0" />
              ) : (
                <ChevronsLeft size={16} className="shrink-0" />
              )}
            </button>
          </div>
      </div>
      {/* 第二行：侧边栏 + 主内容，占满横栏之外的全部高度 */}
      <div className="flex min-h-0 flex-1">
      <AppSidebar
        activeApp={activeApp}
        onSwitch={(app) => {
          // 切换 App 时持久化，刷新后 getInitialApp 才能恢复上次的 App
          localStorage.setItem(STORAGE_KEY, app);
          setActiveApp(app);
          setCurrentView("providers");
        }}
        visibleApps={visibleApps}
        onOpenSettings={() => {
          setSettingsDefaultTab("general");
          setCurrentView("settings");
        }}
        settingsActive={currentView === "settings"}
        onOpenHome={() => setCurrentView("home")}
        homeActive={currentView === "home"}
        collapsed={sidebarCollapsed}
        onWidthChange={setSidebarWidth}
      />
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {showEnvBanner && envConflicts.length > 0 && (
          <EnvWarningBanner
            conflicts={envConflicts}
            onDismiss={() => {
              setShowEnvBanner(false);
              sessionStorage.setItem("env_banner_dismissed", "true");
            }}
            onDeleted={async () => {
              try {
                const allConflicts = await checkAllEnvConflicts();
                const flatConflicts = Object.values(allConflicts).flat();
                setEnvConflicts(flatConflicts);
                if (flatConflicts.length === 0) {
                  setShowEnvBanner(false);
                }
              } catch (error) {
                console.error(
                  "[App] Failed to re-check conflicts after deletion:",
                  error,
                );
              }
            }}
          />
        )}

        <header
          className="shrink-0 transition-all duration-300 bg-background/80 backdrop-blur-md"
          {...DRAG_REGION_ATTR}
          style={
            {
              ...DRAG_REGION_STYLE,
              height: HEADER_HEIGHT,
            } as any
          }
        >
          <div
            className="flex h-full items-center justify-between gap-2 px-6"
            {...DRAG_REGION_ATTR}
            style={{ ...DRAG_REGION_STYLE } as any}
          >
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as any}
            >
              {currentView !== "providers" ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={managementBusy}
                    aria-label={t("common.back")}
                    onClick={() =>
                      setCurrentView(
                        currentView === "skillsDiscovery"
                          ? "skills"
                          : "providers",
                      )
                    }
                    className={cn(
                      "mr-2 rounded-lg",
                      managementBusy && "disabled:opacity-100",
                    )}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                  <h1 className="text-lg font-semibold">
                    {currentView === "home" && t("home.title")}
                    {currentView === "settings" && t("settings.title")}
                    {currentView === "prompts" &&
                      t("prompts.title", {
                        appName: t(`apps.${sharedFeatureApp}`),
                      })}
                    {currentView === "skills" && t("skills.title")}
                    {currentView === "skillsDiscovery" && t("skills.title")}
                    {currentView === "mcp" && t("mcp.unifiedPanel.title")}
                    {currentView === "agents" && t("agents.title")}
                    {currentView === "universal" &&
                      t("universalProvider.title", {
                        defaultValue: "统一供应商",
                      })}
                    {currentView === "sessions" && t("sessionManager.title")}
                    {currentView === "workspace" && t("workspace.title")}
                    {currentView === "openclawEnv" && t("openclaw.env.title")}
                    {currentView === "openclawTools" &&
                      t("openclaw.tools.title")}
                    {currentView === "openclawAgents" &&
                      t("openclaw.agents.title")}
                    {currentView === "hermesMemory" && t("hermes.memory.title")}
                  </h1>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {/* 功能入口（skills/prompts/会话/MCP 等）：置于 header 最前。
                      按实际支持能力决定是否渲染整个胶囊——WorkBuddy 目前仅
                      支持会话，胶囊内就只会出现「会话」一项，不会留空灰块 */}
                  {hasFeatureEntries && (
                    <div className="flex items-center gap-1 p-1 bg-muted rounded-xl">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={
                            activeApp === "openclaw"
                              ? "openclaw"
                              : activeApp === "hermes"
                                ? "hermes"
                                : activeApp === "grokbuild"
                                  ? "grokbuild"
                                  : "default"
                          }
                          className="flex items-center gap-1"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          {activeApp === "hermes" ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("skills")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("skills.manage")}
                              >
                                <SkillIcon size={16} className="shrink-0" />
                                <span className="text-xs">{t("toolbar.skills")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("hermesMemory")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("hermes.memory.title")}
                              >
                                <Brain className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.memory")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void openHermesWebUI()}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("hermes.webui.open")}
                              >
                                <LayoutDashboard className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.webui")}</span>
                              </Button>
                              {hasMcpSupport && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCurrentView("mcp")}
                                  className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                  title={t("mcp.title")}
                                >
                                  <McpIcon size={16} className="shrink-0" />
                                  <span className="text-xs">{t("toolbar.mcp")}</span>
                                </Button>
                              )}
                            </>
                          ) : activeApp === "openclaw" ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("workspace")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("workspace.manage")}
                              >
                                <FolderOpen className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.workspace")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawEnv")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("openclaw.env.title")}
                              >
                                <KeyRound className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.env")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawTools")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("openclaw.tools.title")}
                              >
                                <Shield className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.tools")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("openclawAgents")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("openclaw.agents.title")}
                              >
                                <Cpu className="w-4 h-4 shrink-0" />
                                <span className="text-xs">{t("toolbar.agents")}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCurrentView("sessions")}
                                className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                title={t("sessionManager.title")}
                              >
                                <SessionIcon size={16} className="shrink-0" />
                                <span className="text-xs">{t("toolbar.sessions")}</span>
                              </Button>
                            </>
                          ) : (
                            <>
                              {hasSkillsSupport && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCurrentView("skills")}
                                  className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                  title={t("skills.manage")}
                                >
                                  <SkillIcon size={16} className="shrink-0" />
                                  <span className="text-xs">{t("toolbar.skills")}</span>
                                </Button>
                              )}
                              {hasPromptSupport && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCurrentView("prompts")}
                                  className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                  title={t("prompts.manage")}
                                >
                                  <PromptIcon size={16} className="shrink-0" />
                                  <span className="text-xs">{t("toolbar.prompts")}</span>
                                </Button>
                              )}
                              {hasSessionSupport && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCurrentView("sessions")}
                                  className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                  title={t("sessionManager.title")}
                                >
                                  <SessionIcon size={16} className="shrink-0" />
                                  <span className="text-xs">{t("toolbar.sessions")}</span>
                                </Button>
                              )}
                              {hasMcpSupport && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCurrentView("mcp")}
                                  className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                                  title={t("mcp.title")}
                                >
                                  <McpIcon size={16} className="shrink-0" />
                                  <span className="text-xs">{t("toolbar.mcp")}</span>
                                </Button>
                              )}
                            </>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  )}
                  {/* 安装状态：已安装显示版本，未安装显示安装按钮（失败给手动安装指引）。
                      与完成通知开关同一排，都是「当前 agent 的全局开关类信息」 */}
                  <ToolInstallStatus appId={activeApp} />
                  {/* 完成通知配置：紧跟在「技能/提示词/会话/MCP」这排入口右侧并排 */}
                  <AgentNotificationSettings
                    providerId={activeApp}
                    providerLabel={t(`apps.${activeApp}`)}
                    providerColor={getProviderNotifyColor(activeApp)}
                    setting={
                      settingsData?.agentNotifications?.[activeApp] ??
                      DEFAULT_AGENT_NOTIFICATION
                    }
                    onChange={(next) => updateAgentNotification(activeApp, next)}
                  />
                  <RoutingActivationBrand
                    active={isProxyRunning && isCurrentAppTakeoverActive}
                    contextKey={activeApp}
                    appLabel={t(`apps.${activeApp}`)}
                    takeoverSupported={currentAppUsesProxy}
                    ready={
                      proxyStatus !== undefined && takeoverStatus !== undefined
                    }
                  />
                  <UpdateBadge
                    onClick={() => {
                      setSettingsDefaultTab("about");
                      setCurrentView("settings");
                    }}
                  />
                  {isCurrentAppTakeoverActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSettingsDefaultTab("usage");
                        setCurrentView("settings");
                      }}
                      title={t("usage.title", {
                        defaultValue: "使用统计",
                      })}
                      className="text-muted-foreground hover:text-foreground hover-soft gap-1.5 px-2.5"
                    >
                      <BarChart2 className="w-4 h-4 shrink-0" />
                      <span className="text-xs">
                        {t("usage.title", { defaultValue: "使用统计" })}
                      </span>
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-1 min-w-0 items-center justify-end gap-1.5">
              {currentView === "providers" &&
                (activeApp === "claude-desktop" || proxyAppId) && (
                  <div
                    className="flex shrink-0 items-center gap-1.5"
                    style={{ WebkitAppRegion: "no-drag" } as any}
                  >
                    {activeApp === "claude-desktop" ? (
                      <ClaudeDesktopRouteToggle />
                    ) : proxyAppId ? (
                      <>
                        {settingsData?.enableLocalProxy && (
                          <ProxyToggle activeApp={proxyAppId} />
                        )}
                        {settingsData?.enableFailoverToggle && (
                          <FailoverToggle activeApp={proxyAppId} />
                        )}
                      </>
                    ) : null}
                  </div>
                )}
              {currentView === "providers" &&
                (settingsData?.showProfileSwitcher ?? true) && (
                  <div
                    className="flex shrink-0 items-center"
                    style={{ WebkitAppRegion: "no-drag" } as any}
                  >
                    <ProfileSwitcher activeApp={activeApp} />
                  </div>
                )}
              {/* 固定右端：主操作（添加供应商等）shrink-0，任何配置下不被挤出 */}
              <div className="flex shrink-0 items-center py-4">
                <div
                  className="flex shrink-0 items-center gap-1.5"
                  style={{ WebkitAppRegion: "no-drag" } as any}
                >
                  {currentView === "prompts" && promptPrimaryAction && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={promptManagementBusy}
                      onClick={() => promptPanelRef.current?.openAdd()}
                      className="hover-soft disabled:opacity-100"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      {t(
                        promptPrimaryAction === "template"
                          ? "pi.prompts.newTemplate"
                          : "prompts.add",
                      )}
                    </Button>
                  )}
                  {currentView === "mcp" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mcpManagementBusy}
                        onClick={() => mcpPanelRef.current?.openImport()}
                        className="hover-soft disabled:opacity-100"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        {t("mcp.importExisting")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mcpManagementBusy}
                        onClick={() => mcpPanelRef.current?.openAdd()}
                        className="hover-soft disabled:opacity-100"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        {t("mcp.addMcp")}
                      </Button>
                    </>
                  )}
                  {currentView === "skills" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          skillsManagementBusy ||
                          skillsCheckUpdatesState.isChecking ||
                          !skillsCheckUpdatesState.hasSkills
                        }
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.checkUpdates()
                        }
                        className={cn(
                          "hover-soft",
                          skillsManagementBusy && "disabled:opacity-100",
                        )}
                      >
                        {skillsCheckUpdatesState.isChecking ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-2" />
                        )}
                        {skillsCheckUpdatesState.isChecking
                          ? t("skills.checkingUpdates")
                          : t("skills.checkUpdates")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={skillsManagementBusy}
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.openRestoreFromBackup()
                        }
                        className="hover-soft disabled:opacity-100"
                      >
                        <History className="w-4 h-4 mr-2" />
                        {t("skills.restoreFromBackup.button")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={skillsManagementBusy}
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.openInstallFromZip()
                        }
                        className="hover-soft disabled:opacity-100"
                      >
                        <FolderArchive className="w-4 h-4 mr-2" />
                        {t("skills.installFromZip.button")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={skillsManagementBusy}
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.openImport()
                        }
                        className="relative hover-soft disabled:opacity-100"
                        title={
                          hasUnmanagedSkills
                            ? t("skills.unmanagedAvailable")
                            : undefined
                        }
                      >
                        <Download className="w-4 h-4 mr-2" />
                        {t("skills.import")}
                        {hasUnmanagedSkills && (
                          <span
                            className="absolute top-1 right-1 h-2 w-2 rounded-full bg-green-500"
                            aria-hidden="true"
                          />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={skillsManagementBusy}
                        onClick={() =>
                          unifiedSkillsPanelRef.current?.openDiscovery()
                        }
                        className="hover-soft disabled:opacity-100"
                      >
                        <Search className="w-4 h-4 mr-2" />
                        {t("skills.discover")}
                      </Button>
                    </>
                  )}
                  {currentView === "skillsDiscovery" && (
                    <>
                      {getSkillsPageHeaderActions(skillsDiscoverySource).map(
                        ({ key, labelKey, Icon, execute }) => (
                          <Button
                            key={key}
                            variant="ghost"
                            size="sm"
                            onClick={() => execute(skillsPageRef.current)}
                            className="hover-soft"
                          >
                            <Icon className="w-4 h-4 mr-2" />
                            {t(labelKey)}
                          </Button>
                        ),
                      )}
                    </>
                  )}
                  {currentView === "providers" && (
                    <>
                      <Button
                        onClick={() => setIsAddOpen(true)}
                        size="icon"
                        className={`ml-2 ${addActionButtonClass}`}
                        aria-label={t("provider.addNewProvider")}
                        title={t("provider.addNewProvider")}
                      >
                        <Plus className="w-5 h-5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0 flex flex-col overflow-y-auto animate-fade-in">
          {isOpenClawView && openclawHealthWarnings.length > 0 && (
            <OpenClawHealthBanner warnings={openclawHealthWarnings} />
          )}
          {renderContent()}
        </main>
      </div>

      <AddProviderDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        appId={activeApp}
        onSubmit={addProvider}
      />

      <EditProviderDialog
        open={Boolean(editingProvider)}
        provider={effectiveEditingProvider}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProvider(null);
          }
        }}
        onSubmit={handleEditProvider}
        appId={activeApp}
        isProxyTakeover={isCurrentAppTakeoverActive}
      />

      {effectiveUsageProvider && (
        <UsageScriptModal
          key={effectiveUsageProvider.id}
          provider={effectiveUsageProvider}
          appId={activeApp}
          isOpen={Boolean(usageProvider)}
          onClose={() => setUsageProvider(null)}
          onSave={(script) => {
            if (usageProvider) {
              void saveUsageScript(usageProvider, script);
            }
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmAction)}
        title={
          confirmAction?.action === "remove"
            ? t("confirm.removeProvider")
            : t("confirm.deleteProvider")
        }
        message={confirmActionMessage}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        isOpen={launchDashboardOpen}
        title={t("hermes.webui.launchConfirmTitle")}
        message={t("hermes.webui.launchConfirmMessage")}
        confirmText={t("hermes.webui.launchConfirmAction")}
        variant="info"
        onConfirm={() => {
          setLaunchDashboardOpen(false);
          void (async () => {
            try {
              await hermesApi.launchDashboard();
              toast.success(t("hermes.webui.launching"));
            } catch (error) {
              toast.error(t("hermes.webui.launchFailed"), {
                description: extractErrorMessage(error) || undefined,
              });
            }
          })();
        }}
        onCancel={() => setLaunchDashboardOpen(false)}
      />

      <DeepLinkImportDialog />
      <FirstRunNoticeDialog />
      </div>
    </div>
  );
}

export default App;
