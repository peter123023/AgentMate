import { useCallback, useEffect, useMemo, useState } from "react";
import {
  settingsApi,
  type ToolInstallation,
  type ToolInstallationReport,
} from "@/lib/api/settings";
import { isUpdateAvailable } from "@/lib/version";
import type { AppId } from "@/lib/api/types";

/** 可安装/升级的 CLI 工具名（与设置「关于」页保持一致）。 */
const TOOL_APP_IDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
};

/** AppId -> 后端工具名；找不到说明该 app 不是 CLI 工具（如 claude-desktop）。 */
export function toolNameForApp(appId: AppId): string | null {
  return TOOL_APP_IDS[appId] ?? null;
}

export interface ToolVersionInfo {
  name: string;
  version: string | null;
  latest_version: string | null;
  error: string | null;
  installed_but_broken: boolean;
  env_type: string;
}

// 跨重挂缓存：应用切来切去不该每次都跑一次 `--version` 子进程 + 一次网络请求。
// 生命周期 = JS 模块（应用会话），与设置页的 10 分钟 TTL 策略一致。
const CACHE_TTL_MS = 10 * 60 * 1000;
const versionCache = new Map<string, { data: ToolVersionInfo; at: number }>();
// 冲突标记随 installs 一起缓存：否则缓存新鲜时不再重探，
// 「装了 ≥2 处」的保守初值会一直误报成冲突。
const installsCache = new Map<
  string,
  { data: ToolInstallation[]; conflict: boolean; at: number }
>();

function isFresh(at: number): boolean {
  return Date.now() - at < CACHE_TTL_MS;
}

/** 清空模块级缓存（测试用；也可在「重新检测」入口调用）。 */
export function clearToolInstallInfoCache(): void {
  versionCache.clear();
  installsCache.clear();
}

const EMPTY_INSTALLS: ToolInstallation[] = [];

interface UseToolInstallInfoOptions {
  /** 是否启用查询（如当前 app 不支持安装信息时传 false）。 */
  enabled?: boolean;
}

/**
 * 某个 app 对应的 CLI 工具安装信息，供「工具详情页顶部」展示。
 *
 * 只做两件事：拿版本（含最新版本，判断能否升级）+ 拿安装分布（是否有冲突）。
 *
 * 安装分布走 probeToolInstallations（1-3 秒跨进程探测）。**挂载即后台探测**，
 * 但探测期间不阻塞渲染（折叠行先显示版本，路径等结果回来再补），结果缓存 10 分钟，
 * 同一个会话内切换 agent 不会重复跑。
 */
export function useToolInstallInfo(
  appId: AppId,
  { enabled = true }: UseToolInstallInfoOptions = {},
) {
  const toolName = toolNameForApp(appId);

  const cachedVersion = toolName ? versionCache.get(toolName) : undefined;
  const [version, setVersion] = useState<ToolVersionInfo | null>(
    cachedVersion && isFresh(cachedVersion.at) ? cachedVersion.data : null,
  );
  const [versionLoading, setVersionLoading] = useState(
    enabled &&
      Boolean(toolName) &&
      !(cachedVersion && isFresh(cachedVersion.at)),
  );

  const [installs, setInstalls] = useState<ToolInstallation[]>(
    toolName && installsCache.has(toolName)
      ? (installsCache.get(toolName)?.data ?? EMPTY_INSTALLS)
      : EMPTY_INSTALLS,
  );
  const [installsLoading, setInstallsLoading] = useState(false);
  const [installsLoaded, setInstallsLoaded] = useState(
    Boolean(toolName && installsCache.has(toolName)),
  );
  // 后端严阈值判定（≥2 处且版本分歧或运行态混合）。比"装了 ≥2 处"更准：
  // 同版本装两份且都能跑不算冲突，不该给用户告警。
  const [isConflict, setIsConflict] = useState(false);

  // 切换 app 时同步换一份状态（缓存命中则直接显示，不闪 loading）
  useEffect(() => {
    if (!toolName || !enabled) {
      setVersion(null);
      setInstalls(EMPTY_INSTALLS);
      setInstallsLoaded(false);
      setIsConflict(false);
      setVersionLoading(false);
      return;
    }
    const hit = versionCache.get(toolName);
    if (hit && isFresh(hit.at)) {
      setVersion(hit.data);
      setVersionLoading(false);
    } else {
      setVersion(null);
      setVersionLoading(true);
    }
    const installHit = installsCache.get(toolName);
    setInstalls(installHit?.data ?? EMPTY_INSTALLS);
    setInstallsLoaded(Boolean(installHit));
    setIsConflict(installHit?.conflict ?? false);
  }, [toolName, enabled]);

  // 版本探测：轻量（单次子进程 + 版本接口），进页面就查
  useEffect(() => {
    if (!toolName || !enabled) return;
    const hit = versionCache.get(toolName);
    if (hit && isFresh(hit.at)) return;

    let disposed = false;
    setVersionLoading(true);
    void settingsApi
      .getToolVersions([toolName])
      .then((rows) => {
        const row = rows.find((r) => r.name === toolName) ?? rows[0];
        if (!row || disposed) return;
        const info: ToolVersionInfo = {
          name: row.name,
          version: row.version,
          latest_version: row.latest_version,
          error: row.error,
          installed_but_broken: row.installed_but_broken,
          env_type: row.env_type,
        };
        versionCache.set(toolName, { data: info, at: Date.now() });
        setVersion(info);
      })
      .catch((error) => {
        console.error("[useToolInstallInfo] 探测工具版本失败", error);
      })
      .finally(() => {
        if (!disposed) setVersionLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [toolName, enabled]);

  /** 懒加载安装分布（用户展开详情时调用），已加载过则直接返回。 */
  const loadInstalls = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (!toolName) return;
      const hit = installsCache.get(toolName);
      if (hit && isFresh(hit.at) && !opts.force) {
        setInstalls(hit.data);
        setInstallsLoaded(true);
        setIsConflict(hit.conflict);
        return;
      }
      setInstallsLoading(true);
      try {
        const [report] = await settingsApi.probeToolInstallations([toolName]);
        const list = report?.installs ?? EMPTY_INSTALLS;
        const conflict = Boolean(report?.is_conflict);
        installsCache.set(toolName, { data: list, conflict, at: Date.now() });
        setInstalls(list);
        setInstallsLoaded(true);
        setIsConflict(conflict);
      } catch (error) {
        console.error("[useToolInstallInfo] 探测安装分布失败", error);
      } finally {
        setInstallsLoading(false);
      }
    },
    [toolName],
  );

  // 折叠行要显示安装路径 / 冲突徽章，这些只有安装分布探测能给出；
  // 因此进页面就后台跑一次（不阻塞渲染，折叠行先显示版本），结果进缓存。
  useEffect(() => {
    if (!toolName || !enabled) return;
    const hit = installsCache.get(toolName);
    if (hit && isFresh(hit.at)) return;
    void loadInstalls();
  }, [toolName, enabled, loadInstalls]);

  /**
   * 强制重新探测（安装/升级后刷新展示）。
   *
   * 版本探测（快）会 await 完成，让调用方能立刻拿到新状态给 toast 用；
   * 安装分布探测（1-3 秒跨进程）走后台、不 await——它只影响路径/冲突这类
   * 次要信息，不该拖慢"安装完成"的反馈。两者都会写回模块级缓存，避免
   * 后续切换 agent 再跑一遍。
   */
  const refresh = useCallback(async (): Promise<ToolVersionInfo | null> => {
    if (!toolName) return null;
    versionCache.delete(toolName);
    installsCache.delete(toolName);

    let latest: ToolVersionInfo | null = null;
    setVersionLoading(true);
    try {
      const rows = await settingsApi.getToolVersions([toolName]);
      const row = rows.find((r) => r.name === toolName) ?? rows[0];
      if (row) {
        const info: ToolVersionInfo = {
          name: row.name,
          version: row.version,
          latest_version: row.latest_version,
          error: row.error,
          installed_but_broken: row.installed_but_broken,
          env_type: row.env_type,
        };
        versionCache.set(toolName, { data: info, at: Date.now() });
        setVersion(info);
        latest = info;
      }
    } catch (error) {
      console.error("[useToolInstallInfo] 刷新工具版本失败", error);
    } finally {
      setVersionLoading(false);
    }

    void loadInstalls({ force: true });
    return latest;
  }, [toolName, loadInstalls]);

  /** 宽阈值：装了 ≥2 处（不论是否真冲突）。 */
  const hasConflict = useMemo(() => installs.length > 1, [installs]);
  const canUpdate = useMemo(
    () => isUpdateAvailable(version?.version, version?.latest_version),
    [version],
  );

  return {
    toolName,
    supported: Boolean(toolName),
    version,
    versionLoading,
    installs,
    installsLoading,
    installsLoaded,
    hasConflict,
    isConflict,
    canUpdate,
    loadInstalls,
    refresh,
  };
}

export type { ToolInstallation, ToolInstallationReport };
