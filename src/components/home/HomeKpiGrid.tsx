import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Coins,
  Gauge,
  Layers,
  Loader2,
  Timer,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useProviderStats, useUsageSummary } from "@/lib/query/usage";
import { resolveUsageRange } from "@/lib/usageRange";
import {
  fmtUsd,
  formatTokensShort,
  getResolvedLang,
  parseFiniteNumber,
} from "@/components/usage/format";
import { cn } from "@/lib/utils";
import type { UsageRangeSelection } from "@/types/usage";

interface HomeKpiGridProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
}

const DAY_SECONDS = 24 * 60 * 60;

/** 区间覆盖的自然天数（不足一天按一天算），用于日均类指标。 */
function rangeDayCount(range: UsageRangeSelection): number {
  const { startDate, endDate } = resolveUsageRange(range);
  return Math.max(1, Math.ceil((endDate - startDate) / DAY_SECONDS));
}

interface Kpi {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  /** 数值语义色：good=正常/健康，warn=需关注，bad=异常。 */
  tone?: "good" | "warn" | "bad" | "neutral";
}

const TONE_CLASS: Record<NonNullable<Kpi["tone"]>, string> = {
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-rose-500",
  neutral: "text-primary",
};

/**
 * 主页看板的派生指标行。
 *
 * Hero 已经给出总量（Tokens / 请求数 / 成本 / 缓存），这里补齐「质量与效率」
 * 维度：成功率、平均延迟、单次请求均价、单次请求 Token、日均请求、日均成本。
 */
export function HomeKpiGrid({ range, refreshIntervalMs }: HomeKpiGridProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);

  const options = {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };

  const { data: summary } = useUsageSummary(range, undefined, options);
  const { data: providerStats } = useProviderStats(range, undefined, options);

  const kpis = useMemo<Kpi[]>(() => {
    const requests = summary?.totalRequests ?? 0;
    const tokens = summary?.realTotalTokens ?? 0;
    const cost = parseFiniteNumber(summary?.totalCost) ?? 0;
    const days = rangeDayCount(range);

    // 按请求数加权平均延迟——直接对各行 avgLatencyMs 求算术平均会被
    // 低频供应商拉偏。
    const totalProviderRequests =
      providerStats?.reduce((sum, p) => sum + p.requestCount, 0) ?? 0;
    const weightedLatency =
      totalProviderRequests > 0
        ? (providerStats ?? []).reduce(
            (sum, p) => sum + p.avgLatencyMs * p.requestCount,
            0,
          ) / totalProviderRequests
        : null;

    const successRate = summary?.successRate ?? 0;
    const costPerRequest = requests > 0 ? cost / requests : null;
    const tokensPerRequest = requests > 0 ? tokens / requests : null;

    return [
      {
        key: "successRate",
        label: t("usage.successRate", "成功率"),
        value: `${successRate.toFixed(1)}%`,
        hint:
          successRate >= 99
            ? t("home.kpiHint.stable", "运行稳定")
            : t("home.kpiHint.checkErrors", "存在失败请求"),
        icon: <Gauge className="h-3.5 w-3.5" />,
        tone: successRate >= 99 ? "good" : successRate >= 90 ? "warn" : "bad",
      },
      {
        key: "avgLatency",
        label: t("usage.avgLatency", "平均延迟"),
        value:
          weightedLatency == null
            ? "--"
            : weightedLatency >= 1000
              ? `${(weightedLatency / 1000).toFixed(2)}s`
              : `${Math.round(weightedLatency)}ms`,
        hint: t("home.kpiHint.weightedByRequests", "按请求数加权"),
        icon: <Timer className="h-3.5 w-3.5" />,
        tone:
          weightedLatency == null
            ? "neutral"
            : weightedLatency < 2000
              ? "good"
              : weightedLatency < 5000
                ? "warn"
                : "bad",
      },
      {
        key: "costPerRequest",
        label: t("home.kpi.costPerRequest", "单次请求均价"),
        value: costPerRequest == null ? "--" : fmtUsd(costPerRequest, 4),
        hint: t("home.kpiHint.costPerRequest", "总成本 ÷ 请求数"),
        icon: <Coins className="h-3.5 w-3.5" />,
        tone: "neutral",
      },
      {
        key: "tokensPerRequest",
        label: t("home.kpi.tokensPerRequest", "单次请求 Tokens"),
        value:
          tokensPerRequest == null
            ? "--"
            : formatTokensShort(Math.round(tokensPerRequest), lang),
        hint: t("home.kpiHint.tokensPerRequest", "含缓存读写"),
        icon: <Layers className="h-3.5 w-3.5" />,
        tone: "neutral",
      },
      {
        key: "dailyRequests",
        label: t("home.kpi.dailyRequests", "日均请求"),
        value: Math.round(requests / days).toLocaleString(),
        hint: t("home.kpiHint.perDay", "按 {{value}} 天摊平", { value: days }),
        icon: <Activity className="h-3.5 w-3.5" />,
        tone: "neutral",
      },
      {
        key: "dailyCost",
        label: t("home.kpi.dailyCost", "日均成本"),
        value: fmtUsd(cost / days, 4),
        hint: t("home.kpiHint.perDay", "按 {{value}} 天摊平", { value: days }),
        icon: <TrendingUp className="h-3.5 w-3.5" />,
        tone: "neutral",
      },
    ];
  }, [summary, providerStats, range, t, lang]);

  const isLoading = summary === undefined && providerStats === undefined;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {isLoading
        ? Array.from({ length: 6 }).map((_, index) => (
            <Card
              key={index}
              className="border border-border/50 bg-card/40 backdrop-blur-sm"
            >
              <CardContent className="flex h-[76px] items-center justify-center p-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
              </CardContent>
            </Card>
          ))
        : kpis.map((kpi) => (
            <Card
              key={kpi.key}
              className="border border-border/50 bg-card/40 backdrop-blur-sm"
            >
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className={cn(TONE_CLASS[kpi.tone ?? "neutral"])}>
                    {kpi.icon}
                  </span>
                  <span className="truncate">{kpi.label}</span>
                </div>
                <div
                  className={cn(
                    "mt-1.5 text-lg font-semibold tabular-nums leading-none",
                    kpi.tone && kpi.tone !== "neutral"
                      ? TONE_CLASS[kpi.tone]
                      : "text-foreground",
                  )}
                >
                  {kpi.value}
                </div>
                <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
                  {kpi.hint}
                </div>
              </CardContent>
            </Card>
          ))}
    </div>
  );
}
