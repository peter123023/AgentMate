/**
 * WorkBuddy provider presets configuration.
 *
 * WorkBuddy stores its model list as a JSON array in `~/.workbuddy/models.json`.
 * Each ModelBoard provider maps 1:1 to an entry in that array, so a preset's
 * `settingsConfig` is exactly one models.json entry:
 *
 * ```json
 * {
 *   "id": "glm-5.3-flash",
 *   "name": "glm-5.3-flash",
 *   "vendor": "Custom",
 *   "url": "https://.../v1",
 *   "apiKey": "...",
 *   "supportsToolCall": true,
 *   "supportsImages": false,
 *   "supportsReasoning": false,
 *   "useCustomProtocol": false
 * }
 * ```
 *
 * `id` is filled in by the backend (`workbuddy_config::set_provider`) from the
 * provider id, and the entry `name` follows the ModelBoard provider name.
 */
import type { ProviderCategory } from "../types";
import type { PresetTheme } from "./claudeProviderPresets";

export interface WorkBuddyProviderSettingsConfig {
  /** Entry id in models.json — always overwritten with the provider id. */
  id?: string;
  name: string;
  vendor: string;
  url: string;
  apiKey: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol: boolean;
  [key: string]: unknown;
}

export interface WorkBuddyProviderPreset {
  name: string;
  nameKey?: string;
  websiteUrl: string;
  settingsConfig: WorkBuddyProviderSettingsConfig;
  isOfficial?: boolean;
  isPartner?: boolean;
  primePartner?: boolean; // 置顶合作伙伴（顶级）：徽章显示为心形
  partnerPromotionKey?: string;
  category?: ProviderCategory;
  theme?: PresetTheme;
  icon?: string;
  iconColor?: string;
}

export const workbuddyProviderPresets: WorkBuddyProviderPreset[] = [
  {
    name: "火山方舟（Volcano Ark）",
    websiteUrl: "https://console.volcengine.com/ark",
    settingsConfig: {
      name: "ark-code-latest",
      vendor: "Custom",
      url: "https://ark.cn-beijing.volces.com/api/coding/v3",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
    icon: "huoshan",
    iconColor: "#225CFF",
  },
  {
    name: "Ollama 本地模型",
    websiteUrl: "https://ollama.com",
    settingsConfig: {
      name: "qwen3-coder",
      vendor: "Custom",
      url: "http://127.0.0.1:11434/v1/chat/completions",
      apiKey: "ollama",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "自定义 OpenAI 兼容端点",
    websiteUrl: "",
    settingsConfig: {
      name: "custom-model",
      vendor: "Custom",
      url: "https://your-endpoint.example.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "custom",
  },
];
