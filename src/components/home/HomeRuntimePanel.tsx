import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Radio, Clock3, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProxyStatusQuery, useProxyTakeoverStatus } from "@/lib/query/proxy";
import { useUsageSummary, useUsageTrends } from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import type { UsageRangeSelection } from "@/types/usage";

interface HomeRuntimePanelProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * 运行状态 + 用量时间分布。
 *
 * 代理是 CC Switch 的数据入口，它没跑起来时统计会静默停止——所以把
 * running / 端口 / 累计请求放在主页常驻，比翻到设置页看更及时发现。
 */
export function HomeRuntimePanel({
  range,
  refreshIntervalMs,
}: HomeRuntimePanelProps) {
  const { t } = useTranslation();

  const options = {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };

  const { data: proxy } = useProxyStatusQuery();
  const { data: takeover } = useProxyTakeoverStatus(false);
  const { data: trends } = useUsageTrends(range, undefined, options);
  const { data: summary } = useUsageSummary(range, undefined, options);

  const takenOverApps = useMemo(
    () =>
      Object.entries(takeover ?? {})
        .filter(([, on]) => on)
        .map(([app]) => app),
    [takeover],
  );

  const isHourly = range.preset === "today" || range.preset === "1d";

  const peak = useMemo(() => {
    const rows = trends ?? [];
    if (rows.length === 0) return null;
    const top = rows.reduce((max, row) =>
      row.requestCount > max.requestCount ? row : max,
    );
    if (top.requestCount === 0) return null;
    const d = new Date(top.date);
    const label = isHourly
      ? d.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
    return { label, count: top.requestCount };
  }, [trends, isHourly]);

  const requests = summary?.totalRequests ?? 0;
  const failedRequests = Math.round(
    requests * (1 - (summary?.successRate ?? 0) / 100),
  );

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">
          {t("home.runtime.title", "运行状态")}
        </CardTitle>
        <span
          className={cn(
            "flex items-center gap-1 text-[11px] font-medium",
            proxy?.running ? "text-emerald-500" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              proxy?.running ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
          {proxy?.running
            ? t("home.runtime.proxyRunning", "代理运行中")
            : t("home.runtime.proxyStopped", "代理未启动")}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Radio className="h-3.5 w-3.5 text-sky-500" />
              {t("home.runtime.port", "监听端口")}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none">
              {proxy?.port ?? "--"}
            </div>
            <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
              {t("home.runtime.uptime", "已运行 {{value}}", {
                value: formatUptime(proxy?.uptime_seconds ?? 0),
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Activity className="h-3.5 w-3.5 text-indigo-500" />
              {t("home.runtime.proxyRequests", "代理累计请求")}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none">
              {(proxy?.total_requests ?? 0).toLocaleString()}
            </div>
            <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
              {t("home.runtime.failovers", "故障转移 {{value}} 次", {
                value: proxy?.failover_count ?? 0,
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5 text-amber-500" />
              {t("home.runtime.peak", "用量高峰")}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none">
              {peak?.label ?? "--"}
            </div>
            <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
              {t("home.runtime.peakCount", "{{value}} 次请求", {
                value: peak?.count?.toLocaleString() ?? 0,
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <XCircle className="h-3.5 w-3.5 text-rose-500" />
              {t("home.runtime.failedRequests", "失败请求")}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none">
              {failedRequests.toLocaleString()}
            </div>
            <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
              {t("home.runtime.failedRatio", "占 {{value}}", {
                value: `${requests > 0 ? ((failedRequests / requests) * 100).toFixed(1) : "0.0"}%`,
              })}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("home.runtime.takenOver", "已接管")}
            </span>
            <span className="text-[11px] font-semibold tabular-nums">
              {takenOverApps.length}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {takenOverApps.length === 0 ? (
              <span className="text-[10px] text-muted-foreground/80">
                {t("home.runtime.noTakeover", "没有 App 走本地代理")}
              </span>
            ) : (
              takenOverApps.map((app) => (
                <span
                  key={app}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium"
                >
                  {t(`usage.appFilter.${app}`, { defaultValue: app })}
                </span>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
