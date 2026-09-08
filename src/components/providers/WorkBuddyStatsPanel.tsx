import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, RefreshCw, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { providersApi } from "@/lib/api/providers";

const fmtCredits = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: value < 100 ? 2 : 0,
  });

const fmtTokens = (value: number) => value.toLocaleString("en-US");

/**
 * WorkBuddy 页面顶部的积分与消耗面板（紧凑单行版）。
 *
 * - 积分余额：用本地登录凭证调 WorkBuddy 云端接口（尽力而为，失败静默降级）。
 * - 本地消耗：只展示今日 + 近 7 天的积分与 Token（自然日口径，不展示累计）。
 * - 两个数据源都不可用时整个面板隐藏，不打扰正常的供应商管理。
 */
export function WorkBuddyStatsPanel() {
  const { t } = useTranslation();

  const balanceQuery = useQuery({
    queryKey: ["workbuddyCreditsBalance"],
    queryFn: () => providersApi.getWorkBuddyCreditsBalance(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const usageQuery = useQuery({
    queryKey: ["workbuddyUsageStats"],
    queryFn: () => providersApi.getWorkBuddyUsageStats(),
    staleTime: 60 * 1000,
    retry: false,
  });

  const balance = balanceQuery.data;
  const usage = usageQuery.data;

  const balanceAvailable = balance?.available === true;
  const usageAvailable = usage?.available === true;

  // 两个数据源都不可用（未装 WorkBuddy / 未登录）→ 不渲染面板
  if (!balanceAvailable && !usageAvailable) {
    if (balanceQuery.isLoading || usageQuery.isLoading) {
      return (
        <div className="h-[52px] rounded-lg border border-border bg-muted/30 animate-pulse" />
      );
    }
    return null;
  }

  const packages = balance?.packages ?? [];
  const totalRemain = packages.reduce((sum, p) => sum + p.remain, 0);
  const totalCapacity = packages.reduce((sum, p) => sum + p.total, 0);
  const usagePercent =
    totalCapacity > 0
      ? Math.min(
          100,
          Math.round(((totalCapacity - totalRemain) / totalCapacity) * 100),
        )
      : 0;

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* 积分余额（紧凑：标题+数值+细进度条 同行） */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Coins className="h-4 w-4 shrink-0 text-amber-500" />
          {balanceAvailable ? (
            <>
              <div className="shrink-0">
                <p className="text-[10px] leading-tight text-muted-foreground">
                  {t("workbuddy.stats.creditsTitle")}
                </p>
                <p className="text-sm font-semibold tabular-nums leading-tight">
                  {fmtCredits(totalRemain)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    / {fmtCredits(totalCapacity)}
                  </span>
                </p>
              </div>
              <div className="h-1 min-w-[60px] flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${
                    usagePercent > 90
                      ? "bg-red-500"
                      : usagePercent > 70
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                disabled={balanceQuery.isFetching}
                onClick={() => balanceQuery.refetch()}
                title={t("common.refresh", { defaultValue: "刷新" })}
              >
                <RefreshCw
                  className={`h-3 w-3 ${balanceQuery.isFetching ? "animate-spin" : ""}`}
                />
              </Button>
            </>
          ) : (
            <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="truncate">
                {balance?.reason === "unauthorized"
                  ? t("workbuddy.stats.creditsUnauthorized")
                  : t("workbuddy.stats.creditsUnavailable")}
              </span>
            </p>
          )}
        </div>

        <div className="hidden h-8 w-px shrink-0 bg-border/60 lg:block" />

        {/* 本地消耗（紧凑 4 格：今日/近7天 积分 + Token） */}
        {usageAvailable ? (
          <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-4">
            <Stat
              label={t("workbuddy.stats.today")}
              value={fmtCredits(usage!.todayCredits)}
            />
            <Stat
              label={t("workbuddy.stats.last7d")}
              value={fmtCredits(usage!.last7dCredits)}
            />
            <Stat
              label={`${t("workbuddy.stats.today")} · Tokens`}
              value={fmtTokens(usage!.todayTokens)}
            />
            <Stat
              label={`${t("workbuddy.stats.last7d")} · Tokens`}
              value={fmtTokens(usage!.last7dTokens)}
            />
          </div>
        ) : (
          <p className="shrink-0 text-xs text-muted-foreground">
            {t("workbuddy.stats.usageUnavailable")}
          </p>
        )}
      </div>

      {balance?.reason === "unauthorized" && (
        <a
          href="https://www.workbuddy.cn"
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t("workbuddy.stats.openWorkBuddy")}
        </a>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] leading-tight text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}
