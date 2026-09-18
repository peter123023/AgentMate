import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { playNotificationSound } from "@/lib/notificationSound";
import type { AgentCompletion } from "@/types";

interface Bridge {
  providerLabel: string;
  providerColor: string;
}

/**
 * provider id -> 展示名 / 主色，用于提示窗口里的品牌识别。
 * 与会话面板的 provider 命名保持一致。
 */
const PROVIDER_BRIDGE: Record<string, Bridge> = {
  claude: { providerLabel: "Claude Code", providerColor: "#D97757" },
  codex: { providerLabel: "Codex", providerColor: "#10A37F" },
  opencode: { providerLabel: "OpenCode", providerColor: "#6366F1" },
  openclaw: { providerLabel: "OpenClaw", providerColor: "#0EA5E9" },
  gemini: { providerLabel: "Gemini CLI", providerColor: "#4285F4" },
  hermes: { providerLabel: "Hermes", providerColor: "#A855F7" },
  grokbuild: { providerLabel: "Grok Build", providerColor: "#111827" },
  pi: { providerLabel: "Pi", providerColor: "#EC4899" },
  workbuddy: { providerLabel: "WorkBuddy", providerColor: "#2563EB" },
  "deepseek-harness": { providerLabel: "DeepSeek", providerColor: "#4D6BFE" },
};

function bridgeFor(providerId: string): Bridge {
  return (
    PROVIDER_BRIDGE[providerId] ?? {
      providerLabel: providerId,
      providerColor: "hsl(var(--primary))",
    }
  );
}

function projectName(projectDir?: string | null): string | null {
  if (!projectDir) return null;
  const parts = projectDir.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

export function NotifyCard() {
  const { t } = useTranslation();
  const [completion, setCompletion] = useState<AgentCompletion | null>(null);
  const closingRef = useRef(false);

  // 先拉一次挂起通知，再订阅事件：避免事件早于监听注册而丢失。
  useEffect(() => {
    let disposed = false;

    void invoke<AgentCompletion | null>("get_pending_agent_completion")
      .then((pending) => {
        if (!disposed && pending) {
          setCompletion(pending);
          playNotificationSound(pending.sound ?? "none");
        }
      })
      .catch((error) => {
        console.error("读取挂起的 agent 通知失败", error);
      });

    const unlisten = listen<AgentCompletion>("agent-completion", (event) => {
      if (!disposed) {
        // 新通知到来 = 新的一次可操作提示：复位一次性点击闸门。
        // 提示窗口会被后端复用（隐藏后重新 show），不复位的话同一个
        // webview 里点过一次之后，后续所有通知都点不了（22:29 实测）。
        closingRef.current = false;
        setCompletion(event.payload);
        // 按该 agent 的配置播放提示音（"none" 静默）。
        playNotificationSound(event.payload.sound ?? "none");
      }
    });

    return () => {
      disposed = true;
      void unlisten.then((off) => off());
    };
  }, []);

  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    void invoke("dismiss_agent_completion").catch((error) => {
      console.error("关闭 agent 提示失败", error);
    });
  }, []);

  /**
   * 点击「打开 Agent」：由后端重建 resume 命令并拉起终端，
   * 提示窗口由后端关闭。非 macOS 不支持拉终端，降级为复制命令。
   */
  const openSession = useCallback(() => {
    if (!completion || closingRef.current) return;
    closingRef.current = true;
    void invoke("open_agent_completion", {
      providerId: completion.providerId,
      sessionId: completion.sessionId,
    }).catch((error) => {
      console.error("打开 agent 失败", error);
      if (completion.resumeCommand) {
        void navigator.clipboard
          .writeText(completion.resumeCommand)
          .catch(() => {
            // 剪贴板不可用时只能放弃，窗口仍会被后端关闭。
          });
      }
    });
  }, [completion]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  if (!completion) {
    return <div className="notify-card" />;
  }

  const bridge = bridgeFor(completion.providerId);
  const project = projectName(completion.projectDir);
  const relativeTime = formatRelative(completion.completedAt, nowMs(), t);
  // 品牌色经 CSS 变量下发：按钮/图标/进度条统一取色，
  // color-mix 生成淡底色，避免在 TS 里拼 hex alpha（对 hsl() 值无效）。
  // 用户为该 agent 配了自定义颜色时优先用它（见设置的「通知颜色」）。
  const colorStyle = {
    "--nb-color": completion.color || bridge.providerColor,
  } as React.CSSProperties;

  return (
    <div className="notify-card" style={colorStyle}>
      <div
        className="notify-surface"
        role="button"
        tabIndex={0}
        onClick={openSession}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openSession();
          }
        }}
      >
        <div
          className="notify-progress"
          style={{ animationDuration: `${NOTIFY_TTL_MS}ms` }}
        />

        <div className="flex items-start gap-3">
          <span className="notify-icon">
            <CheckCircle2 className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1 pt-0.5">
            <div className="truncate text-[13px] font-semibold leading-5">
              {t("agents.completionNotice.title", {
                provider: bridge.providerLabel,
              })}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] leading-4 text-muted-foreground">
              {t("agents.completionNotice.subtitle", {
                project: project ?? t("agents.completionNotice.noProject"),
              })}
            </div>
          </div>

          <span className="shrink-0 pt-1 text-[11px] leading-4 text-muted-foreground/80">
            {relativeTime}
          </span>
        </div>

        {completion.title && (
          <p className="line-clamp-1 text-[12px] leading-5 text-foreground/80">
            {completion.title}
          </p>
        )}

        <div className="notify-actions">
          <button
            type="button"
            className="notify-btn notify-btn-ghost"
            onClick={(event) => {
              event.stopPropagation();
              dismiss();
            }}
          >
            {t("agents.completionNotice.dismiss")}
          </button>
          <button
            type="button"
            className="notify-btn notify-btn-primary"
            onClick={(event) => {
              event.stopPropagation();
              openSession();
            }}
          >
            {t("agents.completionNotice.open", {
              provider: bridge.providerLabel,
            })}
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const NOTIFY_TTL_MS = 12_000;

function nowMs(): number {
  return Date.now();
}

function formatRelative(
  completedAt: number,
  current: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const diff = Math.max(0, current - completedAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("agents.completionNotice.justNow");
  return t("agents.completionNotice.minutesAgo", { value: minutes });
}
