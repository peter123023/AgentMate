import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRequestLogs } from "@/lib/query/usage";
import { fmtUsd, getLocaleFromLanguage } from "@/components/usage/format";
import { cn } from "@/lib/utils";
import type { UsageRangeSelection } from "@/types/usage";

interface HomeRecentRequestsProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
  limit?: number;
}

function statusTone(statusCode: number): string {
  if (statusCode >= 500) return "text-rose-500";
  if (statusCode >= 400) return "text-amber-500";
  if (statusCode >= 200 && statusCode < 300) return "text-emerald-500";
  return "text-muted-foreground";
}

/**
 * 最近请求列表（紧凑版）。
 *
 * 与完整统计页的 RequestLogTable 不同：这里只取最新 N 条做「当前在跑什么」
 * 的即时感知，不做分页与筛选。
 */
export function HomeRecentRequests({
  range,
  refreshIntervalMs,
  limit = 8,
}: HomeRecentRequestsProps) {
  const { t, i18n } = useTranslation();
  const locale = getLocaleFromLanguage(i18n.resolvedLanguage || i18n.language);

  const { data, isLoading } = useRequestLogs({
    filters: {},
    range,
    page: 0,
    pageSize: limit,
    options: {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  });

  const logs = data?.data ?? [];

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">
          {t("home.recentRequests", "最近请求")}
        </CardTitle>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t("home.recentRequestsHint", "最新 {{value}} 条", { value: limit })}
        </span>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        {isLoading ? (
          <div className="flex h-[120px] items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
            {t("usage.noData", "暂无数据")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/40">
            <div className="grid grid-cols-[92px_1fr_72px_84px_76px] items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>{t("home.columns.time", "时间")}</span>
              <span>{t("home.columns.target", "应用 / 模型")}</span>
              <span className="text-right">
                {t("home.columns.status", "状态")}
              </span>
              <span className="text-right">
                {t("home.columns.cost", "成本")}
              </span>
              <span className="text-right">
                {t("home.columns.latency", "延迟")}
              </span>
            </div>
            <div className="divide-y divide-border/40">
              {logs.map((log) => (
                <div
                  key={log.requestId}
                  className="grid grid-cols-[92px_1fr_72px_84px_76px] items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <span className="truncate text-[11px] text-muted-foreground tabular-nums">
                    {new Date(log.createdAt * 1000).toLocaleString(locale, {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[11px] text-muted-foreground">
                      {log.providerName || log.appType}
                    </span>
                    <span className="truncate font-mono text-[11px]">
                      {log.pricingModel || log.model}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-right text-[11px] font-semibold tabular-nums",
                      statusTone(log.statusCode),
                    )}
                  >
                    {log.statusCode || "--"}
                  </span>
                  <span className="text-right text-[11px] tabular-nums">
                    {fmtUsd(log.totalCostUsd, 4)}
                  </span>
                  <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                    {log.latencyMs >= 1000
                      ? `${(log.latencyMs / 1000).toFixed(2)}s`
                      : `${log.latencyMs}ms`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
