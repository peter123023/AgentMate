import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface HomeRankingItem {
  key: string;
  /** 左侧主标题（可传图标 + 文本节点）。 */
  title: ReactNode;
  /** 左侧副标题，例如成功率 / Token 数。 */
  subtitle?: ReactNode;
  /** 右侧主数值（通常是成本）。 */
  value: string;
  /** 右侧次要数值（通常是请求数）。 */
  caption?: string;
  /** 0–1 的占比，决定进度条宽度。 */
  ratio: number;
  /** 进度条颜色 class，默认主色。 */
  barClassName?: string;
}

interface HomeRankingCardProps {
  title: string;
  /** 标题右侧的补充说明，例如「共 8 个」。 */
  badge?: string;
  items: HomeRankingItem[];
  isLoading?: boolean;
  emptyHint?: string;
}

/**
 * 主页看板的通用排行卡片：左标题 + 右数值 + 占比条。
 *
 * 应用分布 / 供应商 Top / 模型 Top 共用同一份排版，保证三块视觉一致。
 */
export function HomeRankingCard({
  title,
  badge,
  items,
  isLoading,
  emptyHint,
}: HomeRankingCardProps) {
  const { t } = useTranslation();

  return (
    <Card className="border border-border/50 bg-card/40 backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {badge && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {badge}
          </span>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        {isLoading ? (
          <div className="flex h-[132px] items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-[132px] items-center justify-center text-xs text-muted-foreground">
            {emptyHint ?? t("usage.noData", "暂无数据")}
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => (
              <div key={item.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium">
                      {item.title}
                    </span>
                    {item.subtitle && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {item.subtitle}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-xs font-semibold tabular-nums">
                      {item.value}
                    </span>
                    {item.caption && (
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {item.caption}
                      </span>
                    )}
                  </div>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary/70 transition-[width] duration-500 ease-out",
                      item.barClassName,
                    )}
                    style={{
                      width: `${Math.max(1, Math.min(100, item.ratio * 100))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
