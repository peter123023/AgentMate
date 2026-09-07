import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Coins,
  Activity,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { providersApi } from "@/lib/api/providers";

const fmtCredits = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: value < 100 ? 2 : 0,
  });

/**
 * WorkBuddy 页面顶部的积分与消耗面板。
 *
 * - 积分余额：用本地登录凭证调 WorkBuddy 云端接口（尽力而为，失败静默降级）。
 * - 本地消耗：汇总 ~/.workbuddy/workbuddy.db 的 session_usage（只读）。
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
        <div className="h-[74px] rounded-lg border border-border bg-muted/30 animate-pulse" />
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
    <div className="rounded-lg border border-border bg-muted/30 px-5 py-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* 云端积分余额 */}
        <div className="space-y-2 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Coins className="h-3.5 w-3.5 text-amber-500" />
              {t("workbuddy.stats.creditsTitle")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              disabled={balanceQuery.isFetching}
              onClick={() => balanceQuery.refetch()}
              title={t("common.refresh", { defaultValue: "刷新" })}
            >
              <RefreshCw
                className={`h-3 w-3 ${balanceQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          {balanceAvailable ? (
            <>
              <p className="text-2xl font-semibold tabular-nums leading-none">
                {fmtCredits(totalRemain)}
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}
                  / {fmtCredits(totalCapacity)}
                </span>
              </p>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
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
              {packages.length > 1 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {packages.map((pkg) => (
                    <span
                      key={pkg.code}
                      className="text-[11px] text-muted-foreground font-mono"
                    >
                      {fmtCredits(pkg.remain)} / {fmtCredits(pkg.total)}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              {balance?.reason === "unauthorized" ? (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500 mt-0.5" />
                  {t("workbuddy.stats.creditsUnauthorized")}
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground mt-0.5" />
                  {t("workbuddy.stats.creditsUnavailable")}
                </>
              )}
            </p>
          )}
        </div>

        {/* 本地消耗统计 */}
        <div className="space-y-2 min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Activity className="h-3.5 w-3.5 text-teal-500" />
            {t("workbuddy.stats.usageTitle")}
          </p>
          {usageAvailable ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <StatItem
                label={t("workbuddy.stats.today")}
                value={fmtCredits(usage!.todayCredits)}
              />
              <StatItem
                label={t("workbuddy.stats.last7d")}
                value={fmtCredits(usage!.last7dCredits)}
              />
              <StatItem
                label={t("workbuddy.stats.total")}
                value={fmtCredits(usage!.totalCredits)}
              />
              <StatItem
                label={t("workbuddy.stats.sessions")}
                value={String(usage!.sessionCount)}
                sub={t("workbuddy.stats.tokens", {
                  count: usage!.totalTokens,
                })}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("workbuddy.stats.usageUnavailable")}
            </p>
          )}
        </div>
      </div>

      {balance?.reason === "unauthorized" && (
        <a
          href="https://www.workbuddy.cn"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t("workbuddy.stats.openWorkBuddy")}
        </a>
      )}
    </div>
  );
}

function StatItem({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums leading-tight">
        {value}
        {sub && (
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            {sub}
          </span>
        )}
      </p>
    </div>
  );
}
