import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useModelStats,
  useProviderStats,
  useUsageSummaryByApp,
} from "@/lib/query/usage";
import { APP_ICON_MAP } from "@/config/appConfig";
import type { AppId } from "@/lib/api/types";
import {
  formatTokensShort,
  fmtUsd,
  getResolvedLang,
  parseFiniteNumber,
} from "@/components/usage/format";
import { HomeRankingCard, type HomeRankingItem } from "./HomeRankingCard";
import type { UsageRangeSelection } from "@/types/usage";

const REFRESH_FALLBACK = 30000;

function refetchOptions(refreshIntervalMs: number) {
  return {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };
}

/** 应用分布条配色（与 UsageHero 的 TITLE_THEMES 保持一致的语义色）。 */
const APP_BAR_CLASS: Record<string, string> = {
  claude: "bg-amber-500/70",
  codex: "bg-neutral-500/70",
  gemini: "bg-sky-500/70",
  grokbuild: "bg-rose-500/70",
  opencode: "bg-purple-500/70",
  pi: "bg-fuchsia-500/70",
};

/** 供应商 / 模型条按排名递减的配色。 */
const RANK_BAR_CLASS = [
  "bg-indigo-500/70",
  "bg-violet-500/60",
  "bg-blue-500/55",
  "bg-cyan-500/50",
  "bg-teal-500/45",
];

/**
 * 占比口径：有成本数据就按成本算份额，否则退回按请求数，
 * 避免「全部 $0」时进度条全部贴底。
 */
function ratioOf(
  value: number,
  total: number,
  fallbackValue: number,
  fallbackTotal: number,
) {
  if (total > 0) return value / total;
  if (fallbackTotal > 0) return fallbackValue / fallbackTotal;
  return 0;
}

interface PanelProps {
  range: UsageRangeSelection;
  refreshIntervalMs: number;
}

/** 各 Agent 应用的用量分布（按成本占比排序）。 */
export function HomeAppBreakdown({ range, refreshIntervalMs }: PanelProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);
  const { data, isLoading } = useUsageSummaryByApp(
    range,
    undefined,
    refetchOptions(refreshIntervalMs || REFRESH_FALLBACK),
  );

  const { items, total } = useMemo(() => {
    const rows = data ?? [];
    const totalCost = rows.reduce(
      (sum, row) => sum + (parseFiniteNumber(row.summary.totalCost) ?? 0),
      0,
    );
    const totalRequests = rows.reduce(
      (sum, row) => sum + row.summary.totalRequests,
      0,
    );

    const mapped = rows
      .map<HomeRankingItem & { cost: number; requests: number }>((row) => {
        const cost = parseFiniteNumber(row.summary.totalCost) ?? 0;
        const requests = row.summary.totalRequests;
        return {
          key: row.appType,
          title: (
            <span className="flex items-center gap-1.5">
              {row.appType in APP_ICON_MAP && (
                <span className="inline-flex shrink-0 items-center">
                  {APP_ICON_MAP[row.appType as AppId].icon}
                </span>
              )}
              <span className="truncate">
                {t(`usage.appFilter.${row.appType}`, {
                  defaultValue: row.appType,
                })}
              </span>
            </span>
          ),
          subtitle: `${requests.toLocaleString()} ${t("usage.requests", "请求数")} · ${formatTokensShort(
            row.summary.realTotalTokens,
            lang,
          )}`,
          value: fmtUsd(cost, 4),
          caption: `${(row.summary.successRate || 0).toFixed(0)}%`,
          ratio: ratioOf(cost, totalCost, requests, totalRequests),
          barClassName: APP_BAR_CLASS[row.appType] ?? "bg-primary/70",
          cost,
          requests,
        };
      })
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests);

    return { items: mapped, total: rows.length };
  }, [data, t, lang]);

  return (
    <HomeRankingCard
      title={t("home.appBreakdown", "应用用量分布")}
      badge={
        total > 0
          ? t("home.totalCount", "共 {{value}} 个", { value: total })
          : undefined
      }
      items={items}
      isLoading={isLoading}
    />
  );
}

/** 供应商用量 Top 5。 */
export function HomeTopProviders({ range, refreshIntervalMs }: PanelProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);
  const { data, isLoading } = useProviderStats(
    range,
    undefined,
    refetchOptions(refreshIntervalMs || REFRESH_FALLBACK),
  );

  const { items, total } = useMemo(() => {
    const rows = data ?? [];
    const totalCost = rows.reduce(
      (sum, row) => sum + (parseFiniteNumber(row.totalCost) ?? 0),
      0,
    );
    const totalRequests = rows.reduce((sum, row) => sum + row.requestCount, 0);

    const mapped = rows
      .map<HomeRankingItem & { cost: number; requests: number }>((row) => {
        const cost = parseFiniteNumber(row.totalCost) ?? 0;
        return {
          key: row.providerId || row.providerName,
          title: <span className="truncate">{row.providerName}</span>,
          subtitle: `${(row.successRate || 0).toFixed(1)}% · ${row.avgLatencyMs}ms`,
          value: fmtUsd(cost, 4),
          caption: `${row.requestCount.toLocaleString()} · ${formatTokensShort(row.totalTokens, lang)}`,
          ratio: ratioOf(cost, totalCost, row.requestCount, totalRequests),
          cost,
          requests: row.requestCount,
        };
      })
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
      .slice(0, 5)
      .map((item, index) => ({
        ...item,
        barClassName: RANK_BAR_CLASS[index] ?? "bg-primary/50",
      }));

    return { items: mapped, total: rows.length };
  }, [data, lang]);

  return (
    <HomeRankingCard
      title={t("home.topProviders", "供应商用量 Top 5")}
      badge={
        total > 0
          ? t("home.totalCount", "共 {{value}} 个", { value: total })
          : undefined
      }
      items={items}
      isLoading={isLoading}
    />
  );
}

/** 模型用量 Top 5。 */
export function HomeTopModels({ range, refreshIntervalMs }: PanelProps) {
  const { t, i18n } = useTranslation();
  const lang = getResolvedLang(i18n);
  const { data, isLoading } = useModelStats(
    range,
    undefined,
    refetchOptions(refreshIntervalMs || REFRESH_FALLBACK),
  );

  const { items, total } = useMemo(() => {
    const rows = data ?? [];
    const totalCost = rows.reduce(
      (sum, row) => sum + (parseFiniteNumber(row.totalCost) ?? 0),
      0,
    );
    const totalRequests = rows.reduce((sum, row) => sum + row.requestCount, 0);

    const mapped = rows
      .map<HomeRankingItem & { cost: number; requests: number }>((row) => {
        const cost = parseFiniteNumber(row.totalCost) ?? 0;
        return {
          key: row.model,
          title: (
            <span className="truncate font-mono text-[11px]">{row.model}</span>
          ),
          subtitle: `${row.requestCount.toLocaleString()} ${t("usage.requests", "请求数")} · ${formatTokensShort(
            row.totalTokens,
            lang,
          )}`,
          value: fmtUsd(cost, 4),
          caption: fmtUsd(row.avgCostPerRequest, 6),
          ratio: ratioOf(cost, totalCost, row.requestCount, totalRequests),
          cost,
          requests: row.requestCount,
        };
      })
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
      .slice(0, 5)
      .map((item, index) => ({
        ...item,
        barClassName: RANK_BAR_CLASS[index] ?? "bg-primary/50",
      }));

    return { items: mapped, total: rows.length };
  }, [data, t, lang]);

  return (
    <HomeRankingCard
      title={t("home.topModels", "模型用量 Top 5")}
      badge={
        total > 0
          ? t("home.totalCount", "共 {{value}} 个", { value: total })
          : undefined
      }
      items={items}
      isLoading={isLoading}
    />
  );
}
