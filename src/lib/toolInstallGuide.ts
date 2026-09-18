import { isWindows } from "@/lib/platform";

/**
 * 单工具的「手动安装」指引：终端里可直接执行的命令 + 官方安装文档。
 *
 * 用途：顶部安装状态在**一键安装失败**时给出可复制的兜底方案（网络被墙、
 * 权限不足、PATH 异常等都可能让静默安装失败，用户需要一个能自己动手的出口）。
 *
 * 命令与后端 `install_command_for` 同源：有官方 installer 的走官方脚本，
 * 其余走 npm 全局安装；Windows 上没有 bash，官方脚本一律退成 npm（Hermes
 * 官方提供 PowerShell installer，保留它）。
 */
export interface ToolInstallGuide {
  command: string;
  docsUrl: string;
}

/** npm 包名表（与后端 npm_install_command_for 一致）。 */
const NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  grok: "@xai-official/grok",
  opencode: "opencode-ai",
  openclaw: "openclaw",
  pi: "@earendil-works/pi-coding-agent",
};

const npmCommand = (tool: string): string | null => {
  const pkg = NPM_PACKAGES[tool];
  return pkg ? `npm i -g ${pkg}` : null;
};

const DOCS_URLS: Record<string, string> = {
  claude: "https://docs.claude.com/en/docs/claude-code/setup",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  grok: "https://docs.x.ai/docs/overview",
  opencode: "https://opencode.ai/docs",
  openclaw: "https://www.npmjs.com/package/openclaw",
  hermes: "https://github.com/NousResearch/hermes-agent",
  pi: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
};

/** 官方安装脚本（POSIX-only；Windows 上退 npm）。 */
const POSIX_INSTALLERS: Record<string, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  hermes:
    "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
};

const HERMES_WINDOWS_INSTALLER =
  "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex";

/**
 * 取某工具的手动安装指引；未知工具返回 null（调用方据此不展示手动安装区块）。
 */
export function toolInstallGuide(
  toolName: string | null,
): ToolInstallGuide | null {
  if (!toolName) return null;

  const docsUrl = DOCS_URLS[toolName];
  if (!docsUrl) return null;

  // Windows 只有 Hermes 有官方 PowerShell installer；其余一律 npm。
  if (isWindows()) {
    const command =
      toolName === "hermes" ? HERMES_WINDOWS_INSTALLER : npmCommand(toolName);
    return command ? { command, docsUrl } : null;
  }

  // POSIX：官方 installer 优先，没有就 npm；Hermes 没有 npm 包。
  const command = POSIX_INSTALLERS[toolName] ?? npmCommand(toolName);
  return command ? { command, docsUrl } : null;
}
