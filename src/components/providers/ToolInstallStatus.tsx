import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import type { AppId } from "@/lib/api/types";
import { settingsApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { toolInstallGuide } from "@/lib/toolInstallGuide";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToolInstallRow } from "@/components/settings/ToolInstallRow";
import { useToolInstallInfo } from "@/hooks/useToolInstallInfo";

type ToolState = "checking" | "installed" | "broken" | "missing" | "failed";
type Action = "install" | "update";

interface ToolInstallStatusProps {
  appId: AppId;
}

/**
 * 顶部工具条里的「安装状态」入口，与完成通知开关同一排。
 *
 * 三种可见状态：
 * - 已安装：绿勾 + 「已安装 vX.Y.Z」，点开看路径 / 来源 / 多处安装冲突 / 升级；
 * - 未安装：「安装」按钮，点击直接跑一键安装（后端静默执行官方 installer || npm）；
 * - 安装失败：红叹号 + 「安装失败」，点开给出失败原因 + 可复制的手动安装命令 + 官方文档。
 *
 * 手动安装是兜底出口：网络被墙 / 权限不足 / PATH 异常都会让静默安装失败，
 * 这时必须给用户一条自己能动手的路径，而不是只剩一个转不动的按钮。
 */
export function ToolInstallStatus({ appId }: ToolInstallStatusProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 「已复制」提示的定时器：组件可能在 1.5s 内被卸载（切 agent/关窗口），
  // 不清理会对着已卸载组件 setState。
  const copyTimer = useRef<number | null>(null);
  // 安装/升级是几十秒的异步动作，中途用户可能切走 agent。用 ref 记住
  // 发起时的 appId，回调里比对——否则会把 A 的结果（版本/失败提示）写到 B 上。
  const pendingAppId = useRef<AppId>(appId);
  const {
    toolName,
    supported,
    version,
    versionLoading,
    installs,
    installsLoading,
    isConflict,
    canUpdate,
    loadInstalls,
    refresh,
  } = useToolInstallInfo(appId);

  // 最新的 refresh（绑定当前 toolName）。切走 agent 后要用它把旧结果覆盖回去。
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const toolLabel = t(`apps.${appId}`);

  // 切换 app 时清掉上一个 app 留下的失败态，避免张冠李戴
  useEffect(() => {
    setError(null);
    setBusy(null);
    setCopied(false);
  }, [appId]);

  const runAction = useCallback(
    async (action: Action) => {
      if (!toolName) return;
      const startedFor = appId;
      pendingAppId.current = appId;
      setBusy(action);
      setError(null);
      try {
        await settingsApi.runToolLifecycleAction([toolName], action);
        // 刷新后立刻判成败：命令退出码为 0 但版本仍探不到 = 装上了却跑不起来
        const next = await refresh();
        if (pendingAppId.current !== startedFor) {
          // 已切到别的 agent：刚才 refresh 写进来的版本属于旧工具，重新拉一次当前的数据
          void latestRefresh.current();
          return;
        }
        if (next?.version) {
          toast.success(
            action === "install"
              ? t("settings.toolStatusInstallDone")
              : t("settings.toolStatusUpdateDone"),
          );
          setOpen(false);
        } else {
          const detail = next?.error?.trim() || t("settings.toolNotRunnable");
          setError(detail);
          setOpen(true);
          toast.warning(t("settings.toolStatusInstalledButBroken"), {
            description: detail,
            closeButton: true,
          });
        }
      } catch (err) {
        if (pendingAppId.current !== startedFor) return; // 已切走，别把旧工具的失败挂到新 agent 上
        const detail = extractErrorMessage(err) || String(err);
        setError(detail);
        setOpen(true);
        toast.error(t("settings.toolInstallFailedShort"), {
          description: detail,
          closeButton: true,
        });
      } finally {
        if (pendingAppId.current === startedFor) setBusy(null);
      }
    },
    [toolName, appId, refresh, t],
  );

  const handleCopy = useCallback(async () => {
    const guide = toolInstallGuide(toolName ?? null);
    if (!guide) return;
    try {
      await copyText(guide.command);
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("settings.toolStatusCopyFailed"));
    }
  }, [toolName, t]);

  /** 「重新检测」：用户在终端手动装好后点它，能立刻从失败态回到已安装。 */
  const handleRecheck = useCallback(async () => {
    const next = await refresh();
    if (next?.version) setError(null);
  }, [refresh]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // 展开时补齐安装分布（路径 / 冲突），缓存命中是毫秒级
      if (next) void loadInstalls();
    },
    [loadInstalls],
  );

  if (!supported || !toolName) return null;

  const guide = toolInstallGuide(toolName);
  const state: ToolState = error
    ? "failed"
    : versionLoading && !version
      ? "checking"
      : version?.version
        ? "installed"
        : version?.installed_but_broken
          ? "broken"
          : "missing";

  const versionText = version?.version
    ? `v${version.version.replace(/^v/i, "")}`
    : null;

  const triggerInner = (
    <>
      {state === "checking" || busy !== null ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : state === "installed" ? (
        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
      ) : state === "broken" ? (
        <AlertTriangle className="size-3.5 shrink-0 text-yellow-500" />
      ) : state === "failed" ? (
        <AlertTriangle className="size-3.5 shrink-0" />
      ) : (
        <Download className="size-3.5 shrink-0" />
      )}
      <span className="text-xs">
        {state === "checking"
          ? t("settings.toolStatusChecking")
          : busy === "install"
            ? t("settings.toolStatusInstalling")
            : busy === "update"
              ? t("settings.toolStatusUpdating")
              : state === "installed"
                ? `${t("settings.toolInstalledLabel")} ${versionText}`
                : state === "broken"
                  ? t("settings.toolStatusBroken")
                  : state === "failed"
                    ? t("settings.toolInstallFailedShort")
                    : t("settings.toolInstall")}
      </span>
    </>
  );

  const triggerClass = cn(
    "hover-soft gap-1.5 px-2.5",
    state === "failed"
      ? "text-red-500 hover:text-red-600 dark:text-red-400"
      : "text-muted-foreground hover:text-foreground",
  );

  // 未安装：按钮本身就是安装动作，一点就装（失败会自动弹开手动安装指引）。
  // 检测中：同款按钮但禁用，避免用户在结果出来前重复触发。
  if (state === "missing" || state === "checking") {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={triggerClass}
        disabled={state === "checking" || busy !== null}
        title={
          state === "missing"
            ? t("settings.toolInstall")
            : t("settings.toolStatusChecking")
        }
        onClick={
          state === "missing" ? () => void runAction("install") : undefined
        }
      >
        {triggerInner}
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={triggerClass}
          disabled={busy !== null}
          title={t("settings.toolStatusTitle")}
        >
          {triggerInner}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        {/* 头部：工具名 + 状态 */}
        <div className="border-b bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">
                {t("settings.toolStatusTitle")}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {toolLabel}
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                state === "installed"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : state === "broken"
                    ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                    : "bg-red-500/10 text-red-600 dark:text-red-400",
              )}
            >
              {state === "installed"
                ? `${t("settings.toolInstalledLabel")}${versionText ? ` ${versionText}` : ""}`
                : state === "broken"
                  ? t("settings.toolStatusBroken")
                  : t("settings.toolInstallFailedShort")}
            </span>
          </div>
        </div>

        <div className="space-y-3 px-3 py-3">
          {/* 失败原因 */}
          {error && (
            <p className="break-words rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {/* 已安装：版本 / 路径 / 来源 */}
          {state === "installed" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">
                  {t("settings.toolStatusVersion")}
                </span>
                <span className="font-mono">
                  {versionText}
                  {canUpdate && version?.latest_version && (
                    <span className="ml-1.5 text-[10px] text-primary">
                      → v{version.latest_version.replace(/^v/i, "")}
                    </span>
                  )}
                </span>
              </div>
              {installs.length > 0 ? (
                <div className="space-y-1">
                  {isConflict && (
                    <div className="text-[11px] text-yellow-600 dark:text-yellow-400">
                      {t("settings.toolConflictTitle")}
                    </div>
                  )}
                  <ul className="space-y-1">
                    {installs.map((inst) => (
                      <li key={inst.path}>
                        <ToolInstallRow inst={inst} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : installsLoading ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t("settings.toolDiagnosing")}
                </div>
              ) : null}
            </div>
          )}

          {/* 未安装/失败：手动安装指引 */}
          {(state === "failed" || state === "broken") && guide && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground">
                {t("settings.toolManualInstallHint")}
              </div>
              <div className="flex items-start gap-1.5 rounded-md bg-muted/60 p-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[11px]">
                  {guide.command}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  title={t("settings.toolStatusCopyCommand")}
                  aria-label={t("settings.toolStatusCopyCommand")}
                >
                  {copied ? (
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>
              {/* Tauri webview 里裸 `<a href>` 打不开系统浏览器，必须走 openExternal */}
              <button
                type="button"
                onClick={() => void settingsApi.openExternal(guide.docsUrl)}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                <ExternalLink className="size-3" />
                {t("settings.toolStatusDocs")}
              </button>
            </div>
          )}

          {/* 操作区 */}
          <div className="flex items-center gap-2">
            {state === "failed" || state === "broken" ? (
              <Button
                size="sm"
                className="h-7 flex-1 text-xs"
                disabled={busy !== null}
                onClick={() => void runAction("install")}
              >
                {busy === "install" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("settings.toolStatusRetry")}
              </Button>
            ) : (
              canUpdate && (
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  disabled={busy !== null}
                  onClick={() => void runAction("update")}
                >
                  {busy === "update" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t("settings.toolUpdate")}
                </Button>
              )
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null || versionLoading}
              onClick={() => void handleRecheck()}
            >
              <RefreshCw
                className={cn("size-3.5", versionLoading && "animate-spin")}
              />
              {t("settings.toolStatusRecheck")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
