import { useTranslation } from "react-i18next";
import { Boxes, KeyRound, Puzzle, Sparkles, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_ICON_MAP } from "@/config/appConfig";
import type { AppId } from "@/lib/api/types";
import {
  HOME_STAT_APP_IDS,
  useHomeFailoverStats,
  useHomeMcpStats,
  useHomePromptsStats,
  useHomeProviderInventory,
  useHomeSkillsStats,
} from "@/lib/query/homeAssets";
import { cn } from "@/lib/utils";

interface AssetMetric {
  key: string;
  label: string;
  value: number;
  icon: React.ReactNode;
  hint: string;
  tone: string;
}

/**
 * 配置资产盘点：回答「我到底配了多少东西」。
 *
 * 与下方用量类看板互补——用量讲「花了多少」，这里讲「家底有多厚」。
 */
export function HomeAssetOverview() {
  const { t } = useTranslation();
  const inventory = useHomeProviderInventory();
  const mcp = useHomeMcpStats();
  const skills = useHomeSkillsStats();
  const prompts = useHomePromptsStats();
  const failover = useHomeFailoverStats();

  const isLoading =
    (inventory.isLoading && inventory.perApp.length === 0) ||
    (mcp.isLoading && mcp.total === 0);

  const metrics: AssetMetric[] = [
    {
      key: "providers",
      label: t("home.assets.providers", "供应商"),
      value: inventory.totalUnique,
      icon: <KeyRound className="h-3.5 w-3.5" />,
      hint: t("home.assets.providersHint", "去重后 · 配置 {{value}} 次", {
        value: inventory.totalConfigured,
      }),
      tone: "text-indigo-500",
    },
    {
      key: "mcp",
      label: t("home.assets.mcp", "MCP 服务器"),
      value: mcp.total,
      icon: <Puzzle className="h-3.5 w-3.5" />,
      hint: t("home.assets.mcpHint", "已接入 {{value}} 个客户端", {
        value: Object.keys(mcp.byApp).length,
      }),
      tone: "text-sky-500",
    },
    {
      key: "skills",
      label: t("home.assets.skills", "Skills"),
      value: skills.total,
      icon: <Sparkles className="h-3.5 w-3.5" />,
      hint: t("home.assets.skillsHint", "已安装的技能包"),
      tone: "text-violet-500",
    },
    {
      key: "prompts",
      label: t("home.assets.prompts", "Prompts"),
      value: prompts.total,
      icon: <Boxes className="h-3.5 w-3.5" />,
      hint: t("home.assets.promptsHint", "各 Agent 提示词合计"),
      tone: "text-emerald-500",
    },
  ];

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">
          {t("home.assets.title", "配置资产盘点")}
        </CardTitle>
        {inventory.emptyApps.length > 0 && (
          <span className="text-[11px] text-amber-500">
            {t("home.assets.emptyApps", "{{value}} 个 Agent 未配置供应商", {
              value: inventory.emptyApps.length,
            })}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 pt-0">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.map((metric) => (
            <div
              key={metric.key}
              className="rounded-lg border border-border/40 bg-background/40 p-3"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className={metric.tone}>{metric.icon}</span>
                <span className="truncate">{metric.label}</span>
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums leading-none">
                {metric.value.toLocaleString()}
              </div>
              <div className="mt-1.5 truncate text-[10px] text-muted-foreground/80">
                {metric.hint}
              </div>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="flex h-[120px] items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/40">
            <div className="grid grid-cols-[1fr_56px_1.4fr_48px_48px_48px] items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>{t("home.assets.colAgent", "Agent")}</span>
              <span className="text-right">
                {t("home.assets.colProviders", "供应商")}
              </span>
              <span>{t("home.assets.colCurrent", "当前在用")}</span>
              <span className="text-right">
                {t("home.assets.colFailover", "备用")}
              </span>
              <span className="text-right">
                {t("home.assets.colPrompts", "提示词")}
              </span>
              <span className="text-right">MCP</span>
            </div>
            <div className="divide-y divide-border/40">
              {HOME_STAT_APP_IDS.map((appId) => {
                const row = inventory.perApp.find((a) => a.appId === appId);
                const total = row?.total ?? 0;
                const isEmpty = total === 0;
                return (
                  <div
                    key={appId}
                    className="grid grid-cols-[1fr_56px_1.4fr_48px_48px_48px] items-center gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {appId in APP_ICON_MAP && (
                        <span className="inline-flex shrink-0 items-center">
                          {APP_ICON_MAP[appId as AppId].icon}
                        </span>
                      )}
                      <span className="truncate">
                        {t(`usage.appFilter.${appId}`, { defaultValue: appId })}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "text-right font-semibold tabular-nums",
                        isEmpty && "text-amber-500",
                      )}
                    >
                      {total}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {isEmpty
                        ? t("home.assets.notConfigured", "未配置")
                        : row?.currentProviderName ||
                          t("home.assets.notSelected", "未选择")}
                    </span>
                    <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                      {failover.byApp[appId] ?? 0}
                    </span>
                    <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                      {prompts.byApp[appId] ?? 0}
                    </span>
                    <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                      {mcp.byApp[appId] ?? 0}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
