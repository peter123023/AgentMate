import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ShieldCheck, ShieldX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProviderStats } from "@/lib/query/usage";
import { ENV_CONFLICT_APPS, useHomeEnvConflicts } from "@/lib/query/homeAssets";
import { cn } from "@/lib/utils";
import type { UsageRangeSelection } from "@/types/usage";

interface HomeHealthPanelProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
}

/**
 * 健康与告警：把「不会自己冒出来、但会咬人」的问题常驻在主页。
 *
 * 环境变量冲突尤其典型——系统里残留的 ANTHROPIC_BASE_URL 会悄悄覆盖
 * App 内配置，用户往往要到 "为什么切了供应商没生效" 才会发现。
 */
export function HomeHealthPanel({
  range,
  refreshIntervalMs,
}: HomeHealthPanelProps) {
  const { t } = useTranslation();

  const env = useHomeEnvConflicts();
  const { data: providerStats } = useProviderStats(range, undefined, {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  });

  const conflictList = useMemo(
    () =>
      ENV_CONFLICT_APPS.flatMap((app) =>
        (env.byApp[app] ?? []).map((c) => ({ app, varName: c.varName })),
      ),
    [env.byApp],
  );

  const failing = useMemo(
    () =>
      (providerStats ?? [])
        .filter((p) => p.successRate < 100 && p.requestCount > 0)
        .map((p) => ({ ...p, failureRate: 100 - p.successRate }))
        .sort((a, b) => b.failureRate - a.failureRate)
        .slice(0, 3),
    [providerStats],
  );

  const healthy = env.total === 0 && failing.length === 0;

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">
          {t("home.health.title", "健康与告警")}
        </CardTitle>
        {healthy && (
          <span className="flex items-center gap-1 text-[11px] text-emerald-500">
            <ShieldCheck className="h-3 w-3" />
            {t("home.health.allGood", "一切正常")}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-0">
        {/* 环境变量冲突 */}
        <div
          className={cn(
            "rounded-lg border p-3",
            env.total > 0
              ? "border-amber-500/40 bg-amber-500/5"
              : "border-border/40 bg-background/40",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <AlertTriangle
                className={cn(
                  "h-3.5 w-3.5",
                  env.total > 0 ? "text-amber-500" : "text-muted-foreground/50",
                )}
              />
              {t("home.health.envConflicts", "环境变量冲突")}
            </span>
            <span
              className={cn(
                "text-sm font-semibold tabular-nums",
                env.total > 0 ? "text-amber-500" : "text-muted-foreground",
              )}
            >
              {env.total}
            </span>
          </div>
          {conflictList.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {conflictList.slice(0, 6).map((c) => (
                <span
                  key={`${c.app}-${c.varName}`}
                  className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400"
                >
                  {c.varName}
                </span>
              ))}
              {conflictList.length > 6 && (
                <span className="text-[10px] text-muted-foreground">
                  +{conflictList.length - 6}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-[10px] text-muted-foreground/80">
              {t(
                "home.health.envConflictsClean",
                "未检测到会覆盖配置的环境变量",
              )}
            </p>
          )}
        </div>

        {/* 失败率最高的供应商 */}
        <div className="rounded-lg border border-border/40 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <ShieldX className="h-3.5 w-3.5 text-muted-foreground/50" />
              {t("home.health.failingProviders", "失败请求")}
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {failing.length}
            </span>
          </div>
          {failing.length === 0 ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground/80">
              {t("home.health.noFailures", "本区间没有失败请求")}
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {failing.map((p) => (
                <div key={p.providerId} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11px]">
                      {p.providerName}
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-rose-500">
                      {p.failureRate.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full bg-rose-500/70"
                      style={{
                        width: `${Math.min(100, Math.max(1, p.failureRate))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
