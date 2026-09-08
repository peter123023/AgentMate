import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  CalendarClock,
  Coins,
  Lightbulb,
  PiggyBank,
  Snowflake,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProviderStats, useUsageSummary } from "@/lib/query/usage";
import { useHomeProviderInventory } from "@/lib/query/homeAssets";
import { resolveUsageRange } from "@/lib/usageRange";
import {
  fmtUsd,
  formatTokensShort,
  getResolvedLang,
  parseFiniteNumber,
} from "@/components/usage/format";
import type { UsageRangeSelection } from "@/types/usage";

interface HomeInsightCardsProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
}

const DAY_SECONDS = 24 * 60 * 60;
const MONTH_DAYS = 30;

interface Insight {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
  tone: string;
}

/**
 * 交叉洞察：把「配置数据」和「用量数据」放在一起算出来的结论。
 *
 * 这几项单独看配置或单独看用量都看不出来——例如配了 12 家供应商，
 * 过去 30 天真正跑过请求的只有 3 家，其余都是僵尸配置。
 */
export function HomeInsightCards({
  range,
  refreshIntervalMs,
}: HomeInsightCardsProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);

  const options = {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };

  const { data: summary } = useUsageSummary(range, undefined, options);
  const { data: providerStats } = useProviderStats(range, undefined, options);
  const inventory = useHomeProviderInventory();

  const insights = useMemo<{ items: Insight[]; tip: string | null }>(() => {
    const requests = summary?.totalRequests ?? 0;
    const realTokens = summary?.realTotalTokens ?? 0;
    const cost = parseFiniteNumber(summary?.totalCost) ?? 0;
    const cacheRead = summary?.totalCacheReadTokens ?? 0;

    const { startDate, endDate } = resolveUsageRange(range);
    const days = Math.max(1, Math.ceil((endDate - startDate) / DAY_SECONDS));

    // 综合单价（含缓存折扣），用于估算「这些命中 token 若按常规价计费要多少钱」
    const unitPricePerToken = realTokens > 0 ? cost / realTokens : 0;
    const cacheSaved = cacheRead * unitPricePerToken;

    const dailyCost = cost / days;
    const monthForecast = dailyCost * MONTH_DAYS;

    // 闲置供应商：配了但这段时间一条请求都没有
    const activeNames = new Set(
      (providerStats ?? []).map((p) => p.providerName),
    );
    const configuredNames = new Set(
      inventory.perApp.flatMap((a) => a.providerNames),
    );
    const idleCount = Math.max(
      0,
      configuredNames.size -
        [...configuredNames].filter((name) => activeNames.has(name)).length,
    );

    // 各家实际单价（每百万 token），取最省的一家
    const priced = (providerStats ?? [])
      .map((p) => ({
        name: p.providerName,
        perMillion:
          p.totalTokens > 0
            ? ((parseFiniteNumber(p.totalCost) ?? 0) / p.totalTokens) *
              1_000_000
            : null,
      }))
      .filter(
        (p): p is { name: string; perMillion: number } =>
          p.perMillion != null && p.perMillion > 0,
      )
      .sort((a, b) => a.perMillion - b.perMillion);
    const cheapest = priced[0];

    const items: Insight[] = [
      {
        key: "cacheSaved",
        label: t("home.insights.cacheSaved", "缓存省下"),
        value: cacheSaved > 0 ? fmtUsd(cacheSaved, 2) : "--",
        hint: t("home.insights.cacheSavedHint", "{{value}} tokens 命中", {
          value: formatTokensShort(cacheRead, lang),
        }),
        icon: <PiggyBank className="h-3.5 w-3.5" />,
        tone: "text-emerald-500",
      },
      {
        key: "monthForecast",
        label: t("home.insights.monthForecast", "按此速度月末"),
        value: requests > 0 ? fmtUsd(monthForecast, 2) : "--",
        hint: t("home.insights.monthForecastHint", "日均 {{value}}", {
          value: fmtUsd(dailyCost, 4),
        }),
        icon: <CalendarClock className="h-3.5 w-3.5" />,
        tone: "text-amber-500",
      },
      {
        key: "idleProviders",
        label: t("home.insights.idleProviders", "闲置供应商"),
        value: `${idleCount} / ${configuredNames.size}`,
        hint: t("home.insights.idleProvidersHint", "本区间无请求"),
        icon: <Snowflake className="h-3.5 w-3.5" />,
        tone:
          idleCount > configuredNames.size / 2
            ? "text-amber-500"
            : "text-sky-500",
      },
      {
        key: "cheapest",
        label: t("home.insights.cheapest", "最低单价"),
        value: cheapest ? fmtUsd(cheapest.perMillion, 2) : "--",
        hint: cheapest
          ? t("home.insights.cheapestHint", "{{value}} · 每百万 tokens", {
              value: cheapest.name,
            })
          : t("home.insights.noPricingData", "暂无计价数据"),
        icon: <Coins className="h-3.5 w-3.5" />,
        tone: "text-indigo-500",
      },
    ];

    let tip: string | null = null;
    if (idleCount >= 3) {
      tip = t(
        "home.insights.tipIdle",
        "有 {{value}} 家供应商配了却没在用，可以清理了",
        {
          value: idleCount,
        },
      );
    } else if (inventory.emptyApps.length > 0) {
      tip = t("home.insights.tipEmpty", "还有 Agent 没配供应商，切换时会空转");
    } else if (cheapest && priced.length > 1) {
      const priciest = priced[priced.length - 1];
      const ratio =
        cheapest.perMillion > 0 ? priciest.perMillion / cheapest.perMillion : 0;
      if (ratio >= 2) {
        tip = t(
          "home.insights.tipPriceGap",
          "最贵与最便宜的供应商单价差 {{value}} 倍",
          {
            value: ratio.toFixed(1),
          },
        );
      }
    }

    return { items, tip };
  }, [summary, providerStats, inventory.perApp, range, t, lang]);

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">
          {t("home.insights.title", "交叉洞察")}
        </CardTitle>
        {insights.tip && (
          <span className="flex items-center gap-1 text-[11px] text-amber-500">
            <Lightbulb className="h-3 w-3" />
            <span className="truncate">{insights.tip}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {insights.items.map((item) => (
            <div
              key={item.key}
              className="rounded-lg border border-border/40 bg-background/40 p-3"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className={item.tone}>{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums leading-none">
                {item.value}
              </div>
              <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
                {item.hint}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
