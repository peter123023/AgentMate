import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Cpu, LineChart, ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UsageHero } from "@/components/usage/UsageHero";
import { UsageTrendChart } from "@/components/usage/UsageTrendChart";
import { useUsageEventBridge } from "@/hooks/useUsageEventBridge";
import {
  KNOWN_APP_TYPES,
  type AppTypeFilter,
  type UsageRangePreset,
} from "@/types/usage";
import { useModelStats, useProviderStats } from "@/lib/query/usage";
import { HomeKpiGrid } from "./HomeKpiGrid";
import {
  HomeAppBreakdown,
  HomeTopModels,
  HomeTopProviders,
} from "./HomeBreakdownPanels";
import { HomeRecentRequests } from "./HomeRecentRequests";
import { HomeAssetOverview } from "./HomeAssetOverview";
import { HomeInsightCards } from "./HomeInsightCards";
import { HomeHealthPanel } from "./HomeHealthPanel";
import { HomeRuntimePanel } from "./HomeRuntimePanel";
import { cn } from "@/lib/utils";

interface HomeDashboardProps {
  onOpenUsage: () => void;
}

const RANGE_OPTIONS: { preset: UsageRangePreset; labelKey: string }[] = [
  { preset: "today", labelKey: "usage.rangeToday" },
  { preset: "7d", labelKey: "usage.rangeLast7Days" },
  { preset: "30d", labelKey: "usage.rangeLast30Days" },
];

const REFRESH_INTERVAL_MS = 30000;

// Select 的 "all" 哨兵和用户自定义名称同处一个值域——真有来源/模型叫 "all"
// 就会撞名。动态选项统一加前缀编码隔离值域（与完整统计页同一策略）。
const DYNAMIC_OPTION_PREFIX = "v:";
const encodeOptionValue = (name: string) => `${DYNAMIC_OPTION_PREFIX}${name}`;
const decodeOptionValue = (value: string) =>
  value === "all" ? undefined : value.slice(DYNAMIC_OPTION_PREFIX.length);

type HomeTab = "usage" | "assets" | "ranking" | "runtime";

/**
 * 主页概览看板。
 *
 * 结构：顶部固定「总览焦点」（核心总量 + App/来源/模型三级细分筛选 +
 * 时间范围切换），下方四个 Tab 分区，把原来一条长页面里堆叠的 9 块内容
 * 按语义归类：
 *   - 用量：趋势图 + 派生 KPI + 交叉洞察
 *   - 资产：配置资产盘点（供应商/MCP/Skills/Prompts + App 明细）
 *   - 排行：应用分布 / 供应商 Top / 模型 Top
 *   - 运行：运行状态 + 健康告警 + 最近请求
 *
 * 顶部筛选（appType / providerName / model）只作用于 UsageHero 的集中统计，
 * 与完整统计页的筛选语义一致，便于把总量细分到每个 App / 供应商 / 模型。
 */
export function HomeDashboard({ onOpenUsage }: HomeDashboardProps) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<UsageRangePreset>("today");
  const [tab, setTab] = useState<HomeTab>("usage");
  const range = { preset };
  const rangeLabel =
    RANGE_OPTIONS.find((o) => o.preset === preset)?.labelKey ?? "";

  // 顶部集中统计的三级细分筛选（App → 来源 → 模型）
  const [appType, setAppType] = useState<AppTypeFilter>("all");
  const [providerName, setProviderName] = useState<string | undefined>(
    undefined,
  );
  const [model, setModel] = useState<string | undefined>(undefined);

  // 后端写入新日志时立刻刷新看板，无需等待 30s 轮询
  useUsageEventBridge();

  // 级联筛选：切 App 清 Provider+Model，切 Provider 清 Model（同完整统计页）
  const changeAppType = (next: AppTypeFilter) => {
    setAppType(next);
    if (next !== appType) {
      setProviderName(undefined);
      setModel(undefined);
    }
  };
  const changeProviderName = (next: string | undefined) => {
    setProviderName(next);
    if (next !== providerName) {
      setModel(undefined);
    }
  };

  const optionsRefetch = {
    refetchInterval:
      REFRESH_INTERVAL_MS > 0 ? REFRESH_INTERVAL_MS : (false as const),
  };

  // 下拉选项池：来源随 App 走，模型随 App+来源级联；只列范围内真实有数据的
  const { data: providerOptionsData } = useProviderStats(
    range,
    { appType },
    optionsRefetch,
  );
  const { data: modelOptionsData } = useModelStats(
    range,
    { appType, providerName },
    optionsRefetch,
  );

  const providerOptions = useMemo(() => {
    const names = new Set<string>();
    for (const stat of providerOptionsData ?? []) {
      names.add(stat.providerName);
    }
    if (providerName) names.add(providerName);
    return Array.from(names);
  }, [providerOptionsData, providerName]);

  const modelOptions = useMemo(() => {
    const names = new Set<string>();
    for (const stat of modelOptionsData ?? []) {
      names.add(stat.model);
    }
    if (model) names.add(model);
    return Array.from(names);
  }, [modelOptionsData, model]);

  const tabItems: { id: HomeTab; labelKey: string }[] = [
    { id: "usage", labelKey: "home.tabs.usage" },
    { id: "assets", labelKey: "home.tabs.assets" },
    { id: "ranking", labelKey: "home.tabs.ranking" },
    { id: "runtime", labelKey: "home.tabs.runtime" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4">
      {/* 顶部工具栏：时间范围 + 三级细分筛选 + 完整统计入口 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border p-0.5">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.preset}
                type="button"
                onClick={() => setPreset(option.preset)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  preset === option.preset
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>

          {/* 细分筛选：App / 来源 / 模型 */}
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1">
            <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

            <Select
              value={appType}
              onValueChange={(v) => changeAppType(v as AppTypeFilter)}
            >
              <SelectTrigger
                className="h-6 w-[108px] border-0 bg-transparent px-1.5 text-xs shadow-none focus:ring-0"
                title={t("usage.filterByApp")}
                aria-label={t("usage.filterByApp")}
              >
                <span className="flex items-center gap-1.5 [&>span]:min-w-0 [&>span]:truncate">
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {(["all", ...KNOWN_APP_TYPES] as AppTypeFilter[]).map(
                  (type) => (
                    <SelectItem key={type} value={type}>
                      {t(`usage.appFilter.${type}`)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>

            <Select
              value={
                providerName != null ? encodeOptionValue(providerName) : "all"
              }
              onValueChange={(v) => changeProviderName(decodeOptionValue(v))}
            >
              <SelectTrigger
                className="h-6 w-[110px] border-0 bg-transparent px-1.5 text-xs shadow-none focus:ring-0"
                title={providerName ?? t("usage.filterBySource")}
                aria-label={t("usage.filterBySource")}
              >
                <span className="flex items-center gap-1.5 [&>span]:min-w-0 [&>span]:truncate">
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent className="max-w-[280px]">
                <SelectItem value="all">{t("usage.allSources")}</SelectItem>
                {providerOptions.map((name) => (
                  <SelectItem
                    key={name}
                    value={encodeOptionValue(name)}
                    title={name}
                    className="[&>span]:min-w-0 [&>span]:truncate"
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={model != null ? encodeOptionValue(model) : "all"}
              onValueChange={(v) => setModel(decodeOptionValue(v))}
            >
              <SelectTrigger
                className="h-6 w-[128px] border-0 bg-transparent px-1.5 text-xs shadow-none focus:ring-0"
                title={model ?? t("usage.filterByModel")}
                aria-label={t("usage.filterByModel")}
              >
                <span className="flex items-center gap-1.5 [&>span]:min-w-0 [&>span]:truncate">
                  <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent className="max-w-[280px]">
                <SelectItem value="all">{t("usage.allModels")}</SelectItem>
                {modelOptions.map((name) => (
                  <SelectItem
                    key={name}
                    value={encodeOptionValue(name)}
                    title={name}
                    className="[&>span]:min-w-0 [&>span]:truncate"
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={onOpenUsage}>
          <LineChart className="mr-1 h-3.5 w-3.5" />
          {t("home.openUsage")}
        </Button>
      </div>

      {/* 置顶总览焦点：核心总量，可细分到 App/来源/模型，常驻不随 Tab 切换 */}
      <div className="mb-4 shrink-0">
        <UsageHero
          range={range}
          appType={appType === "all" ? undefined : appType}
          providerName={providerName}
          model={model}
          refreshIntervalMs={REFRESH_INTERVAL_MS}
        />
      </div>

      {/* Tab 分区 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as HomeTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mb-4 self-start">
            {tabItems.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {t(item.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent
            value="usage"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-overlay"
          >
            <UsageTrendChart
              range={range}
              rangeLabel={t(rangeLabel)}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
            />
            <HomeKpiGrid
              range={range}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
            />
            <HomeInsightCards
              range={range}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
            />
          </TabsContent>

          <TabsContent
            value="assets"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-overlay"
          >
            <HomeAssetOverview />
          </TabsContent>

          <TabsContent
            value="ranking"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-overlay"
          >
            <div className="grid gap-4 xl:grid-cols-3">
              <HomeAppBreakdown
                range={range}
                refreshIntervalMs={REFRESH_INTERVAL_MS}
              />
              <HomeTopProviders
                range={range}
                refreshIntervalMs={REFRESH_INTERVAL_MS}
              />
              <HomeTopModels
                range={range}
                refreshIntervalMs={REFRESH_INTERVAL_MS}
              />
            </div>
          </TabsContent>

          <TabsContent
            value="runtime"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-overlay"
          >
            <div className="grid gap-4 xl:grid-cols-2">
              <HomeRuntimePanel
                range={range}
                refreshIntervalMs={REFRESH_INTERVAL_MS}
              />
              <HomeHealthPanel
                range={range}
                refreshIntervalMs={REFRESH_INTERVAL_MS}
              />
            </div>
            <HomeRecentRequests
              range={range}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
