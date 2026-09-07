import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ClaudeIcon, CodexIcon, GeminiIcon } from "@/components/BrandIcons";
import {
  ArrowUpAZ,
  Search,
  Zap,
  Layers,
  Settings2,
  ChevronDown,
} from "lucide-react";
import type { ProviderPreset } from "@/config/claudeProviderPresets";
import type { CodexProviderPreset } from "@/config/codexProviderPresets";
import type { GeminiProviderPreset } from "@/config/geminiProviderPresets";
import type { ClaudeDesktopProviderPreset } from "@/config/claudeDesktopProviderPresets";
import type { OpenCodeProviderPreset } from "@/config/opencodeProviderPresets";
import type { OpenClawProviderPreset } from "@/config/openclawProviderPresets";
import type { HermesProviderPreset } from "@/config/hermesProviderPresets";
import type { WorkBuddyProviderPreset } from "@/config/workbuddyProviderPresets";
import type { PiProviderPreset } from "@/config/piProviderPresets";
import type { ProviderCategory } from "@/types";
import {
  universalProviderPresets,
  type UniversalProviderPreset,
} from "@/config/universalProviderPresets";
import { ProviderIcon } from "@/components/ProviderIcon";

type PresetTranslator = (key: string) => unknown;

export const PresetSortMode = {
  Original: "original",
  NameAsc: "nameAsc",
} as const;

export type PresetSortMode =
  (typeof PresetSortMode)[keyof typeof PresetSortMode];

export type AnyPreset =
  | ProviderPreset
  | CodexProviderPreset
  | GeminiProviderPreset
  | ClaudeDesktopProviderPreset
  | OpenCodeProviderPreset
  | OpenClawProviderPreset
  | HermesProviderPreset
  | PiProviderPreset
  | WorkBuddyProviderPreset;

export type PresetEntry = {
  id: string;
  preset: AnyPreset;
};

export function getPresetDisplayName(
  preset: AnyPreset,
  t: PresetTranslator,
): string {
  return preset.nameKey ? String(t(preset.nameKey)) : preset.name;
}

export function getPresetSearchText(
  entry: PresetEntry,
  t: PresetTranslator,
): string {
  return [getPresetDisplayName(entry.preset, t), entry.preset.name]
    .join(" ")
    .toLowerCase();
}

export function filterPresetEntries(
  entries: PresetEntry[],
  query: string,
  t: PresetTranslator,
): PresetEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) =>
    getPresetSearchText(entry, t).includes(normalizedQuery),
  );
}

// 知名供应商关键词（按知名度大致排序）：命中越靠前展示越靠前；
// 未命中的小供应商统一排在知名供应商之后，按显示名排序。
const WELL_KNOWN_PROVIDER_KEYWORDS = [
  "deepseek",
  "kimi",
  "zhipu glm",
  "qwencloud",
  "bailian",
  "火山",
  "doubao",
  "byteplus",
  "tencent",
  "baidu qianfan",
  "siliconflow",
  "modelscope",
  "minimax",
  "stepfun",
  "xiaomi mimo",
  "longcat",
  "openrouter",
  "nvidia",
  "novita",
  "xai",
] as const;

function wellKnownRank(presetName: string | undefined): number {
  const name = (presetName ?? "").toLowerCase();
  for (let i = 0; i < WELL_KNOWN_PROVIDER_KEYWORDS.length; i++) {
    if (name.includes(WELL_KNOWN_PROVIDER_KEYWORDS[i])) return i;
  }
  return WELL_KNOWN_PROVIDER_KEYWORDS.length;
}

export function sortPresetEntries(
  entries: PresetEntry[],
  sortMode: PresetSortMode,
  t: PresetTranslator,
): PresetEntry[] {
  const byDisplayName = (a: PresetEntry, b: PresetEntry) =>
    getPresetDisplayName(a.preset, t).localeCompare(
      getPresetDisplayName(b.preset, t),
    );

  if (sortMode === PresetSortMode.Original) {
    // 官方分类置顶；其余按知名度排序（知名大厂在前，小供应商按名称排后）
    const official = entries.filter(
      (entry) => entry.preset.category === "official",
    );
    const rest = entries
      .filter((entry) => entry.preset.category !== "official")
      .sort((a, b) => {
        const rankDiff =
          wellKnownRank(a.preset.name) - wellKnownRank(b.preset.name);
        return rankDiff !== 0 ? rankDiff : byDisplayName(a, b);
      });
    return [...official, ...rest];
  }

  return [...entries].sort(byDisplayName);
}

export interface PresetVisibilityOptions {
  query: string;
  sortMode: PresetSortMode;
  t: PresetTranslator;
}

export function getVisiblePresetEntries(
  entries: PresetEntry[],
  options: PresetVisibilityOptions,
): PresetEntry[] {
  const { query, sortMode, t } = options;

  return sortPresetEntries(filterPresetEntries(entries, query, t), sortMode, t);
}

// 同厂商折叠：关键词 -> 厂商标签。命中越靠前优先级越高；
// 未命中视为独立厂商（单条平铺，不折叠）。集中维护，不改动 preset 数据。
const VENDOR_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["tencent", "Tencent"],
  ["hunyuan", "Tencent"],
  ["yuanbao", "Tencent"],
  ["alibaba", "Alibaba"],
  ["qwen", "Alibaba"],
  ["bailian", "Alibaba"],
  ["dashscope", "Alibaba"],
  ["qwencloud", "Alibaba"],
  ["baidu", "Baidu"],
  ["qianfan", "Baidu"],
  ["byte", "ByteDance"],
  ["doubao", "ByteDance"],
  ["volc", "ByteDance"],
  ["ark", "ByteDance"],
  ["火山", "ByteDance"],
  ["zhipu", "Zhipu"],
  ["glm", "Zhipu"],
  ["moonshot", "Moonshot"],
  ["kimi", "Moonshot"],
  ["minimax", "MiniMax"],
  ["deepseek", "DeepSeek"],
  ["siliconflow", "SiliconFlow"],
  ["silicon", "SiliconFlow"],
  ["硅基", "SiliconFlow"],
  ["stepfun", "StepFun"],
  ["modelscope", "ModelScope"],
  ["openrouter", "OpenRouter"],
  ["nvidia", "NVIDIA"],
  ["novita", "Novita"],
  ["xai", "xAI"],
  ["grok", "xAI"],
  ["longcat", "LongCat"],
  ["xiaomi", "Xiaomi"],
  ["mimo", "Xiaomi"],
  ["google", "Google"],
  ["gemini", "Google"],
  ["anthropic", "Anthropic"],
  ["claude", "Anthropic"],
  ["openai", "OpenAI"],
];

function getVendorLabel(preset: AnyPreset): string | undefined {
  const hay = `${preset.name} ${preset.icon ?? ""}`.toLowerCase();
  for (const [keyword, label] of VENDOR_KEYWORDS) {
    if (hay.includes(keyword)) return label;
  }
  return undefined;
}

function renderPresetIcon(preset: AnyPreset) {
  if (preset.icon) {
    return (
      <ProviderIcon
        icon={preset.icon}
        name={preset.name}
        color={preset.iconColor}
        size={16}
        className="flex-shrink-0"
      />
    );
  }

  const iconType = preset.theme?.icon;
  if (iconType) {
    switch (iconType) {
      case "claude":
        return <ClaudeIcon size={14} />;
      case "codex":
        return <CodexIcon size={14} />;
      case "gemini":
        return <GeminiIcon size={14} />;
      case "generic":
        return <Zap size={14} />;
    }
  }

  return <span className="inline-block w-4 h-4 flex-shrink-0" aria-hidden />;
}

function getPresetButtonClass(isSelected: boolean, preset: AnyPreset) {
  const baseClass =
    "inline-flex items-center justify-start gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full";

  if (isSelected) {
    if (preset.theme?.backgroundColor) {
      return `${baseClass} text-white`;
    }
    return `${baseClass} bg-blue-500 text-white dark:bg-blue-600`;
  }

  return `${baseClass} bg-accent text-muted-foreground hover:bg-accent/80`;
}

function getPresetButtonStyle(isSelected: boolean, preset: AnyPreset) {
  if (!isSelected || !preset.theme?.backgroundColor) {
    return undefined;
  }

  return {
    backgroundColor: preset.theme.backgroundColor,
    color: preset.theme.textColor || "#FFFFFF",
  };
}

function PresetIconRenderer({ preset }: { preset: AnyPreset }) {
  return <>{renderPresetIcon(preset)}</>;
}

function PresetButtonItem({
  entry,
  isSelected,
  onPresetChange,
  presetCategoryLabels,
}: {
  entry: PresetEntry;
  isSelected: boolean;
  onPresetChange: (value: string) => void;
  presetCategoryLabels: Record<string, string>;
}) {
  const { t } = useTranslation();
  const presetCategory = entry.preset.category ?? "others";
  return (
    <button
      type="button"
      onClick={() => onPresetChange(entry.id)}
      className={`${getPresetButtonClass(isSelected, entry.preset)} relative`}
      style={getPresetButtonStyle(isSelected, entry.preset)}
      title={presetCategoryLabels[presetCategory] ?? t("providerPreset.other")}
    >
      <PresetIconRenderer preset={entry.preset} />
      <span className="truncate">{getPresetDisplayName(entry.preset, t)}</span>
    </button>
  );
}

function VendorPresetGroup({
  vendor,
  entries,
  selectedPresetId,
  onPresetChange,
  presetCategoryLabels,
}: {
  vendor: string;
  entries: PresetEntry[];
  selectedPresetId: string | null;
  onPresetChange: (value: string) => void;
  presetCategoryLabels: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const first = entries[0].preset;
  const hasSelected = entries.some((entry) => entry.id === selectedPresetId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`${getPresetButtonClass(false, first)} relative`}
          title={vendor}
        >
          <PresetIconRenderer preset={first} />
          <span className="truncate">{vendor}</span>
          <span className="rounded-full bg-background/60 px-1.5 text-[11px] font-medium text-muted-foreground flex-shrink-0">
            {entries.length}
          </span>
          <ChevronDown
            className={`size-4 flex-shrink-0 ml-auto transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          {hasSelected && (
            <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-blue-500 ring-2 ring-background" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1.5">
        <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
          {vendor}
        </div>
        <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
          {entries.map((entry) => (
            <PresetButtonItem
              key={entry.id}
              entry={entry}
              isSelected={selectedPresetId === entry.id}
              onPresetChange={(value) => {
                onPresetChange(value);
                setOpen(false);
              }}
              presetCategoryLabels={presetCategoryLabels}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ProviderPresetSelectorProps {
  selectedPresetId: string | null;
  presetEntries: PresetEntry[];
  presetCategoryLabels: Record<string, string>;
  onPresetChange: (value: string) => void;
  onUniversalPresetSelect?: (preset: UniversalProviderPreset) => void;
  onManageUniversalProviders?: () => void;
  category?: ProviderCategory; // 当前选中的分类
  categoryHint?: ReactNode;
}

export function ProviderPresetSelector({
  selectedPresetId,
  presetEntries,
  presetCategoryLabels,
  onPresetChange,
  onUniversalPresetSelect,
  onManageUniversalProviders,
  category,
  categoryHint,
}: Readonly<ProviderPresetSelectorProps>) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<PresetSortMode>(
    PresetSortMode.Original,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 键盘快捷键: Ctrl/Cmd+F 聚焦常驻搜索输入框。
  // 使用捕获阶段并阻止冒泡，避免背后 ProviderList 的同名快捷键被意外触发。
  // 用 rAF 命令式聚焦（不 select，避免吞掉随后输入的首字符）。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown, true);
    return () => globalThis.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const visiblePresetEntries = useMemo(
    () =>
      getVisiblePresetEntries(presetEntries, {
        query: searchQuery,
        sortMode,
        t,
      }),
    [presetEntries, searchQuery, sortMode, t],
  );

  const groupUnits = useMemo(() => {
    const map = new Map<string, { vendor?: string; entries: PresetEntry[] }>();
    const order: string[] = [];
    for (const entry of visiblePresetEntries) {
      const vendor = getVendorLabel(entry.preset);
      const key = vendor ?? `single:${entry.id}`;
      if (!map.has(key)) {
        map.set(key, { vendor, entries: [] });
        order.push(key);
      }
      map.get(key)!.entries.push(entry);
    }
    return order.map((k) => map.get(k)!);
  }, [visiblePresetEntries]);

  const getCategoryHint = (): ReactNode => {
    if (categoryHint !== undefined) return categoryHint;
    switch (category) {
      case "official":
        return t("providerForm.officialHint", {
          defaultValue: "💡 官方供应商使用浏览器登录，无需配置 API Key",
        });
      case "cn_official":
        return t("providerForm.cnOfficialApiKeyHint", {
          defaultValue: "💡 国产官方供应商只需填写 API Key，请求地址已预设",
        });
      case "aggregator":
        return t("providerForm.aggregatorApiKeyHint", {
          defaultValue: "💡 聚合服务供应商只需填写 API Key 即可使用",
        });
      case "third_party":
        return t("providerForm.thirdPartyApiKeyHint", {
          defaultValue: "💡 第三方供应商需要填写 API Key 和请求地址",
        });
      case "custom":
        return t("providerForm.customApiKeyHint", {
          defaultValue: "💡 自定义配置需手动填写所有必要字段",
        });
      case "omo":
        return t("providerForm.omoHint", {
          defaultValue:
            "💡 OMO 配置管理 Agent 模型分配，兼容 oh-my-openagent.jsonc / oh-my-opencode.jsonc",
        });
      default:
        return t("providerPreset.hint", {
          defaultValue: "选择预设后可继续调整下方字段。",
        });
    }
  };

  const toggleSortMode = () => {
    setSortMode((current) =>
      current === PresetSortMode.Original
        ? PresetSortMode.NameAsc
        : PresetSortMode.Original,
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label>{t("providerPreset.label")}</Label>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchQuery("");
                }
              }}
              placeholder={t("providerPreset.searchPlaceholder", {
                defaultValue: "Search presets...",
              })}
              aria-label={t("providerPreset.searchAriaLabel", {
                defaultValue: "Search provider presets",
              })}
              className="h-8 w-60 pl-8"
            />
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("providerPreset.sortAriaLabel", {
              defaultValue: "Toggle preset sorting",
            })}
            aria-pressed={sortMode === PresetSortMode.NameAsc}
            onClick={toggleSortMode}
            title={
              sortMode === PresetSortMode.NameAsc
                ? t("providerPreset.sortOriginalTooltip", {
                    defaultValue: "Restore original order",
                  })
                : t("providerPreset.sortNameAscTooltip", {
                    defaultValue: "Sort A-Z",
                  })
            }
            className={
              sortMode === PresetSortMode.NameAsc
                ? "size-8 bg-accent text-foreground"
                : "size-8"
            }
          >
            <ArrowUpAZ className="size-4" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        <button
          type="button"
          onClick={() => onPresetChange("custom")}
          className={`inline-flex items-center justify-start gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
            selectedPresetId === "custom"
              ? "bg-blue-500 text-white dark:bg-blue-600"
              : "bg-accent text-muted-foreground hover:bg-accent/80"
          }`}
        >
          <span className="inline-block w-4 h-4 flex-shrink-0" aria-hidden />
          <span className="truncate">{t("providerPreset.custom")}</span>
        </button>

        {visiblePresetEntries.length === 0 && (
          <div className="col-span-full rounded-md border border-dashed border-border-default px-3 py-2 text-xs text-muted-foreground">
            {t("providerPreset.noSearchResults", {
              defaultValue: "No matching presets.",
            })}
          </div>
        )}

        {searchQuery.trim()
          ? visiblePresetEntries.map((entry) => (
              <PresetButtonItem
                key={entry.id}
                entry={entry}
                isSelected={selectedPresetId === entry.id}
                onPresetChange={onPresetChange}
                presetCategoryLabels={presetCategoryLabels}
              />
            ))
          : groupUnits.map((unit) =>
              unit.entries.length === 1 ? (
                <PresetButtonItem
                  key={unit.entries[0].id}
                  entry={unit.entries[0]}
                  isSelected={selectedPresetId === unit.entries[0].id}
                  onPresetChange={onPresetChange}
                  presetCategoryLabels={presetCategoryLabels}
                />
              ) : (
                <VendorPresetGroup
                  key={unit.vendor}
                  vendor={unit.vendor ?? ""}
                  entries={unit.entries}
                  selectedPresetId={selectedPresetId}
                  onPresetChange={onPresetChange}
                  presetCategoryLabels={presetCategoryLabels}
                />
              ),
            )}
      </div>

      {onUniversalPresetSelect && universalProviderPresets.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {universalProviderPresets.map((preset) => (
            <button
              key={`universal-${preset.providerType}`}
              type="button"
              onClick={() => onUniversalPresetSelect(preset)}
              className="inline-flex items-center justify-start gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-accent text-muted-foreground hover:bg-accent/80 relative w-full"
              title={t("universalProvider.hint", {
                defaultValue: "跨应用统一配置，自动同步到 Claude/Codex/Gemini",
              })}
            >
              <ProviderIcon
                icon={preset.icon}
                name={preset.name}
                size={14}
                className="flex-shrink-0"
              />
              <span className="truncate">{preset.name}</span>
              <span className="absolute -top-1 -right-1 flex items-center gap-0.5 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-md">
                <Layers className="h-2.5 w-2.5" />
              </span>
            </button>
          ))}
          {onManageUniversalProviders && (
            <button
              type="button"
              onClick={onManageUniversalProviders}
              className="inline-flex items-center justify-start gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-accent text-muted-foreground hover:bg-accent/80 w-full"
              title={t("universalProvider.manage", {
                defaultValue: "管理统一供应商",
              })}
            >
              <Settings2 className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">
                {t("universalProvider.manage", {
                  defaultValue: "管理",
                })}
              </span>
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{getCategoryHint()}</p>
    </div>
  );
}
