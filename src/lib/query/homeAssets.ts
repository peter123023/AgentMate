import { useQueries, useQuery } from "@tanstack/react-query";
import { providersApi } from "@/lib/api/providers";
import { mcpApi } from "@/lib/api/mcp";
import { promptsApi } from "@/lib/api/prompts";
import { failoverApi } from "@/lib/api/failover";
import { skillsApi } from "@/lib/api/skills";
import { checkAllEnvConflicts } from "@/lib/api/env";
import type { AppId } from "@/lib/api/types";
import type { EnvConflict } from "@/types/env";

/**
 * 主页「配置资产盘点」的统计范围。
 *
 * 只统计真正在 CC Switch 里有供应商库的 App；openclaw / hermes / workbuddy
 * 等走各自的独立配置面板，不纳入主页盘点，避免把无关 App 的 0 也算进来。
 */
export const HOME_STAT_APP_IDS: AppId[] = [
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "pi",
];

/** 主页 Env 冲突检测的 App（后端只支持这四个）。 */
const ENV_CONFLICT_APPS = ["claude", "codex", "gemini", "grokbuild"];

/** 配置类数据变化不频繁，缓存 60s，避免主页反复打后端。 */
const ASSET_STALE_TIME_MS = 60_000;

/** 安全调用：单个 App 查询失败不应让整块看板崩掉。 */
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export interface AppProviderInventory {
  appId: AppId;
  /** 该 App 下配置的供应商数量。 */
  total: number;
  /** 当前启用的供应商 id。 */
  currentProviderId: string;
  /** 当前启用的供应商名称（取不到就回退 id）。 */
  currentProviderName: string;
  /** 供应商名称集合，用于跨 App 去重与「闲置」计算。 */
  providerNames: string[];
}

export interface HomeProviderInventory {
  perApp: AppProviderInventory[];
  /** 各 App 供应商数之和（同一家在多个 App 配置会重复计数）。 */
  totalConfigured: number;
  /** 按名称去重后的供应商数量。 */
  totalUnique: number;
  /** 一个供应商都没配的 App。 */
  emptyApps: AppId[];
  isLoading: boolean;
}

/**
 * 各 App 的供应商盘点：数量 + 当前在用哪家。
 *
 * 供应商按 App 分库存储，Provider 实体没有 app 字段，只能逐 App 拉取后
 * 在前端聚合。六个 App 并发 invoke，单次开销可接受。
 */
export function useHomeProviderInventory(): HomeProviderInventory {
  const results = useQueries({
    queries: HOME_STAT_APP_IDS.map((appId) => ({
      queryKey: ["home", "providers", appId],
      staleTime: ASSET_STALE_TIME_MS,
      queryFn: async () => {
        const [providers, currentProviderId] = await Promise.all([
          safeCall(() => providersApi.getAll(appId), {}),
          safeCall(() => providersApi.getCurrent(appId), ""),
        ]);
        const list = Object.values(providers ?? {});
        return {
          appId,
          total: list.length,
          currentProviderId,
          currentProviderName:
            list.find((p) => p.id === currentProviderId)?.name ??
            (currentProviderId || ""),
          providerNames: list.map((p) => p.name),
        } satisfies AppProviderInventory;
      },
    })),
  });

  const perApp = results
    .map((r) => r.data)
    .filter((d): d is AppProviderInventory => !!d);
  const isLoading = results.some((r) => r.isLoading && r.data === undefined);

  const allNames = perApp.flatMap((a) => a.providerNames);

  return {
    perApp,
    totalConfigured: perApp.reduce((sum, a) => sum + a.total, 0),
    totalUnique: new Set(allNames).size,
    emptyApps: perApp.filter((a) => a.total === 0).map((a) => a.appId),
    isLoading,
  };
}

export interface AppCountStat {
  total: number;
  byApp: Record<string, number>;
  isLoading: boolean;
}

function countByApps(servers: { apps?: object | null }[]): {
  total: number;
  byApp: Record<string, number>;
} {
  const byApp: Record<string, number> = {};
  for (const item of servers) {
    // McpApps / SkillApps 是具体的键值接口而非索引签名，这里统一放宽读取
    const apps = (item.apps ?? {}) as Record<string, unknown>;
    for (const [app, enabled] of Object.entries(apps)) {
      if (enabled !== true) continue;
      byApp[app] = (byApp[app] ?? 0) + 1;
    }
  }
  return { total: servers.length, byApp };
}

/** MCP 服务器统计：总数 + 各 App 启用数。 */
export function useHomeMcpStats(): AppCountStat {
  const { data, isLoading } = useQuery({
    queryKey: ["home", "mcp", "servers"],
    staleTime: ASSET_STALE_TIME_MS,
    queryFn: () => safeCall(() => mcpApi.getAllServers(), {}),
  });

  const servers = Object.values(data ?? {});
  const { total, byApp } = countByApps(servers);
  return { total, byApp, isLoading };
}

/** 已安装 Skills 统计：总数 + 各 App 启用数。 */
export function useHomeSkillsStats(): AppCountStat {
  const { data, isLoading } = useQuery({
    queryKey: ["home", "skills", "installed"],
    staleTime: ASSET_STALE_TIME_MS,
    queryFn: () => safeCall(() => skillsApi.getInstalled(), []),
  });

  const { total, byApp } = countByApps(data ?? []);
  return { total, byApp, isLoading };
}

/** 各 App 的 Prompt 数量。 */
export function useHomePromptsStats(): AppCountStat {
  const results = useQueries({
    queries: HOME_STAT_APP_IDS.map((appId) => ({
      queryKey: ["home", "prompts", appId],
      staleTime: ASSET_STALE_TIME_MS,
      queryFn: async () => {
        const map = await safeCall(
          () => promptsApi.getPrompts(appId),
          {} as Record<string, { enabled?: boolean }>,
        );
        return { appId, count: Object.keys(map ?? {}).length };
      },
    })),
  });

  const byApp: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    if (!r.data) continue;
    byApp[r.data.appId] = r.data.count;
    total += r.data.count;
  }

  return {
    total,
    byApp,
    isLoading: results.some((r) => r.isLoading && r.data === undefined),
  };
}

/** 各 App 的故障转移备用链长度。 */
export function useHomeFailoverStats(): AppCountStat {
  const results = useQueries({
    queries: HOME_STAT_APP_IDS.map((appId) => ({
      queryKey: ["home", "failover", appId],
      staleTime: ASSET_STALE_TIME_MS,
      queryFn: async () => {
        const queue = await safeCall(
          () => failoverApi.getFailoverQueue(appId),
          [],
        );
        return { appId, count: queue?.length ?? 0 };
      },
    })),
  });

  const byApp: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    if (!r.data) continue;
    byApp[r.data.appId] = r.data.count;
    total += r.data.count;
  }

  return {
    total,
    byApp,
    isLoading: results.some((r) => r.isLoading && r.data === undefined),
  };
}

export interface HomeEnvConflicts {
  total: number;
  byApp: Record<string, EnvConflict[]>;
  isLoading: boolean;
}

/**
 * 环境变量冲突检测。
 *
 * 这是「看不出但会咬人」的一类问题：系统里残留的 ANTHROPIC_BASE_URL 会
 * 悄悄覆盖掉 App 内的配置，所以放在主页常驻提醒。
 */
export function useHomeEnvConflicts(): HomeEnvConflicts {
  const { data, isLoading } = useQuery({
    queryKey: ["home", "env", "conflicts"],
    staleTime: ASSET_STALE_TIME_MS,
    queryFn: () => safeCall(() => checkAllEnvConflicts(), {}),
  });

  const byApp = data ?? {};
  const total = Object.values(byApp).reduce(
    (sum, list) => sum + (list?.length ?? 0),
    0,
  );

  return { total, byApp, isLoading };
}

export { ENV_CONFLICT_APPS };
