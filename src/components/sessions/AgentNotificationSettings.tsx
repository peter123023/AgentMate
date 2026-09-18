import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Check, Palette, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentNotificationSetting, AgentNotificationSound } from "@/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { playNotificationSound } from "@/lib/notificationSound";

/** 可选音效（值与后端 AgentNotificationSound 的序列化一致）。 */
export const NOTIFICATION_SOUNDS: AgentNotificationSound[] = [
  "none",
  "system",
  "chime",
  "bell",
  "pop",
  "success",
];

/**
 * 预设主题色。第一项是"跟随 agent 品牌色"（即不做覆盖）。
 * 后面的色值刻意避开语义色（红=错误、绿=成功）以免误解。
 */
const COLOR_PRESETS: Array<{ value: string | null; labelKey: string }> = [
  { value: null, labelKey: "default" },
  { value: "#2563EB", labelKey: "blue" },
  { value: "#7C3AED", labelKey: "violet" },
  { value: "#0891B2", labelKey: "cyan" },
  { value: "#059669", labelKey: "emerald" },
  { value: "#D97706", labelKey: "amber" },
  { value: "#E11D48", labelKey: "rose" },
  { value: "#475569", labelKey: "slate" },
];

/** 未配置过的 agent 的默认通知设置：开启、无声音、用品牌色。 */
export const DEFAULT_AGENT_NOTIFICATION: AgentNotificationSetting = {
  enabled: true,
  sound: "none",
  color: null,
};

interface ControlProps {
  providerId: string;
  setting: AgentNotificationSetting;
  onChange: (next: AgentNotificationSetting) => void;
}

/** 通知设置表单主体（开关 / 声音 / 颜色），被下面两个外层复用。 */
export function AgentNotificationControl({
  providerId,
  setting,
  onChange,
}: ControlProps) {
  const { t } = useTranslation();
  // 自定义颜色的输入草稿：只在用户确认（回车/失焦合法）后写回设置。
  const [colorDraft, setColorDraft] = useState(setting.color ?? "");

  useEffect(() => {
    setColorDraft(setting.color ?? "");
  }, [setting.color, providerId]);

  const handleSoundChange = useCallback(
    (sound: string) => {
      const next = sound as AgentNotificationSound;
      onChange({ ...setting, sound: next });
      // 试听：让用户直接听到选了什么。
      playNotificationSound(next);
    },
    [onChange, setting],
  );

  const handleColorCommit = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) {
        onChange({ ...setting, color: null });
        return;
      }
      // 只接受合法 CSS 十六进制颜色，避免把任意字符串注入 style。
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        setColorDraft(setting.color ?? "");
        return;
      }
      onChange({ ...setting, color: value });
    },
    [onChange, setting],
  );

  return (
    <div className="space-y-3">
      {/* 开关 */}
      <div className="flex items-center justify-between gap-3">
        <Label
          htmlFor={`agent-notify-enabled-${providerId}`}
          className="text-xs font-normal"
        >
          {t("agents.notificationSettings.enable")}
        </Label>
        <Switch
          id={`agent-notify-enabled-${providerId}`}
          checked={setting.enabled}
          onCheckedChange={(checked) =>
            onChange({ ...setting, enabled: checked })
          }
        />
      </div>

      <div
        className={cn(
          "space-y-3 transition-opacity",
          !setting.enabled && "pointer-events-none opacity-40",
        )}
      >
        {/* 提示音 */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Volume2 className="size-3.5 shrink-0" />
            {t("agents.notificationSettings.sound")}
          </div>
          <Select value={setting.sound} onValueChange={handleSoundChange}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_SOUNDS.map((sound) => (
                <SelectItem key={sound} value={sound} className="text-xs">
                  {t(`agents.notificationSettings.sound_${sound}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 主题色 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Palette className="size-3.5 shrink-0" />
            {t("agents.notificationSettings.color")}
          </div>
          {/* 4 列网格：8 个色块正好两行，不会因 flex-wrap 宽度抖动而溢出 */}
          <div className="grid grid-cols-4 gap-2">
            {COLOR_PRESETS.map((preset) => {
              const active = (setting.color ?? null) === preset.value;
              const swatch = preset.value ?? "#94A3B8";
              const label = t(
                `agents.notificationSettings.color_${preset.labelKey}`,
              );
              return (
                <button
                  key={preset.labelKey}
                  type="button"
                  className={cn(
                    "flex h-7 items-center justify-center rounded-md border transition-transform",
                    "hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-foreground/60 ring-2 ring-foreground/20"
                      : "border-border/60",
                  )}
                  style={{ backgroundColor: swatch }}
                  aria-label={label}
                  title={label}
                  onClick={() => onChange({ ...setting, color: preset.value })}
                >
                  {active && (
                    <Check className="size-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" />
                  )}
                </button>
              );
            })}
          </div>
          <Input
            value={colorDraft}
            onChange={(event) => setColorDraft(event.target.value)}
            onBlur={(event) => handleColorCommit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleColorCommit(colorDraft);
              }
            }}
            placeholder="#2563EB"
            aria-label={t("agents.notificationSettings.color")}
            className="h-8 w-full min-w-0 font-mono text-xs"
            spellCheck={false}
          />
          {setting.color && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onChange({ ...setting, color: null })}
            >
              {t("agents.notificationSettings.resetColor")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SettingsProps extends ControlProps {
  /** agent 展示名，用于标题 */
  providerLabel: string;
  /** 品牌色，开启时图标沿用；面板内用于"跟随品牌色"预览 */
  providerColor: string;
}

/**
 * 单个 agent 的完成通知配置入口（铃铛按钮 → Popover）。
 * 用在首页顶部工具条「提示词 / 会话 / MCP」这排入口的右侧，与它们并排。
 */
export function AgentNotificationSettings({
  providerId,
  providerLabel,
  providerColor,
  setting,
  onChange,
}: SettingsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const effectiveColor = setting.color ?? providerColor;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "hover-soft gap-1.5 px-2.5",
            setting.enabled
              ? "text-muted-foreground hover:text-foreground"
              : "text-muted-foreground/40 hover:text-muted-foreground",
          )}
          title={t("agents.notificationSettings.title")}
          aria-label={t("agents.notificationSettings.title")}
        >
          {setting.enabled ? (
            <Bell className="size-4 shrink-0" />
          ) : (
            <BellOff className="size-4 shrink-0" />
          )}
          <span className="text-xs">{t("toolbar.notify")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-72 overflow-hidden p-0"
      >
        {/* 头部：当前 agent + 生效色，用一条品牌色细线收口 */}
        <div className="border-b bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: effectiveColor }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">
                {t("agents.notificationSettings.title")}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {providerLabel}
              </div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                setting.enabled
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {setting.enabled
                ? t("agents.notificationSettings.on")
                : t("agents.notificationSettings.off")}
            </span>
          </div>
        </div>

        {/* 表单主体 */}
        <div className="px-3 py-3">
          <AgentNotificationControl
            providerId={providerId}
            setting={setting}
            onChange={onChange}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
