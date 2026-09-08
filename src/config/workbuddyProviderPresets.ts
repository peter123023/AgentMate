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
 *
 * NOTE: WorkBuddy 客户端请求统一走 OpenAI 兼容协议（真实 models.json 中
 * vendor 均为 "Custom"，端点按各渠道官方 OpenAI 兼容 URL 填写）。
 * 预设中的模型名/URL 只是模板初值——添加后仍可在表单里修改，务必改成
 * 你在该渠道真实开通的模型名与正确的 apiKey。
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

/**
 * WorkBuddy 预设模板：一个供应商 = models.json 里的一个模型条目。
 * 覆盖主流 OpenAI 兼容渠道（国内云厂商 + 海外/聚合/本地推理），
 * 模型名默认给该渠道的代表模型，保存前可按需修改。
 */
export const workbuddyProviderPresets: WorkBuddyProviderPreset[] = [
  // ======================= 原有 3 个（保留） =======================
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

  // ======================= 国内云厂商 =======================
  {
    name: "火山方舟（通用 v3）",
    websiteUrl: "https://console.volcengine.com/ark",
    settingsConfig: {
      name: "doubao-seed-1-6-flash",
      vendor: "Custom",
      url: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
    icon: "huoshan",
    iconColor: "#225CFF",
  },
  {
    name: "DeepSeek 官方",
    websiteUrl: "https://platform.deepseek.com",
    settingsConfig: {
      name: "deepseek-chat",
      vendor: "Custom",
      url: "https://api.deepseek.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "DeepSeek Reasoner（推理）",
    websiteUrl: "https://platform.deepseek.com",
    settingsConfig: {
      name: "deepseek-reasoner",
      vendor: "Custom",
      url: "https://api.deepseek.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "Kimi（Moonshot 官方）",
    websiteUrl: "https://platform.moonshot.cn",
    settingsConfig: {
      name: "kimi-k3",
      vendor: "Custom",
      url: "https://api.moonshot.cn/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "智谱 GLM",
    websiteUrl: "https://open.bigmodel.cn",
    settingsConfig: {
      name: "glm-5.3-flash",
      vendor: "Custom",
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "阿里云百炼 Qwen",
    websiteUrl: "https://bailian.console.aliyun.com",
    settingsConfig: {
      name: "qwen3-coder-plus",
      vendor: "Custom",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "百度千帆",
    websiteUrl: "https://console.bce.baidu.com/qianfan",
    settingsConfig: {
      name: "ernie-4.5-turbo-128k",
      vendor: "Custom",
      url: "https://qianfan.baidubce.com/v2/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "腾讯混元",
    websiteUrl: "https://console.cloud.tencent.com/hunyuan",
    settingsConfig: {
      name: "hunyuan-turbos-latest",
      vendor: "Custom",
      url: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "硅基流动 SiliconFlow",
    websiteUrl: "https://cloud.siliconflow.cn",
    settingsConfig: {
      name: "deepseek-ai/DeepSeek-V3",
      vendor: "Custom",
      url: "https://api.siliconflow.cn/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "阶跃星辰 StepFun",
    websiteUrl: "https://platform.stepfun.com",
    settingsConfig: {
      name: "step-2-mini",
      vendor: "Custom",
      url: "https://api.stepfun.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "cn_official",
  },
  {
    name: "MiniMax（OpenAI 兼容）",
    websiteUrl: "https://platform.minimaxi.com",
    settingsConfig: {
      name: "MiniMax-Text-01",
      vendor: "Custom",
      url: "https://api.minimaxi.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "零一万物 Yi",
    websiteUrl: "https://platform.lingyiwanwu.com",
    settingsConfig: {
      name: "yi-lightning",
      vendor: "Custom",
      url: "https://api.lingyiwanwu.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "third_party",
  },

  // ======================= 海外 / 聚合 / 本地推理 =======================
  {
    name: "OpenAI",
    websiteUrl: "https://platform.openai.com",
    settingsConfig: {
      name: "gpt-5",
      vendor: "Custom",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "Google Gemini",
    websiteUrl: "https://ai.google.dev",
    settingsConfig: {
      name: "gemini-2.5-pro",
      vendor: "Custom",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "xAI Grok",
    websiteUrl: "https://console.x.ai",
    settingsConfig: {
      name: "grok-4",
      vendor: "Custom",
      url: "https://api.x.ai/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "OpenRouter 聚合",
    websiteUrl: "https://openrouter.ai",
    settingsConfig: {
      name: "deepseek/deepseek-chat",
      vendor: "Custom",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "Groq",
    websiteUrl: "https://console.groq.com",
    settingsConfig: {
      name: "llama-3.3-70b-versatile",
      vendor: "Custom",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
  {
    name: "NVIDIA NIM",
    websiteUrl: "https://build.nvidia.com",
    settingsConfig: {
      name: "deepseek-ai/deepseek-r1",
      vendor: "Custom",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      apiKey: "",
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
      useCustomProtocol: false,
    },
    category: "third_party",
  },
];
