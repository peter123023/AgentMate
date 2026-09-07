interface IconProps {
  size?: number;
  className?: string;
}

// 导入本地 SVG 图标
import ClaudeSvg from "@/icons/extracted/claude.svg?url";
import OpenAISvg from "@/icons/extracted/openai.svg?url";
import GeminiSvg from "@/icons/extracted/gemini.svg?url";
import OpenClawSvg from "@/icons/extracted/claw.svg?url";
import workbuddyIcon from "@/icons/extracted/workbuddy.png";
import { cn } from "@/lib/utils";

export function ClaudeIcon({ size = 16, className = "" }: IconProps) {
  return (
    <img
      src={ClaudeSvg}
      width={size}
      height={size}
      className={className}
      alt="Claude"
      loading="lazy"
    />
  );
}

export function CodexIcon({ size = 16, className = "" }: IconProps) {
  return (
    <img
      src={OpenAISvg}
      width={size}
      height={size}
      className={`dark:brightness-0 dark:invert ${className}`}
      alt="Codex"
      loading="lazy"
    />
  );
}

export function GeminiIcon({ size = 16, className = "" }: IconProps) {
  return (
    <img
      src={GeminiSvg}
      width={size}
      height={size}
      className={className}
      alt="Gemini"
      loading="lazy"
    />
  );
}

export function OpenClawIcon({ size = 16, className = "" }: IconProps) {
  return (
    <img
      src={OpenClawSvg}
      width={size}
      height={size}
      className={className}
      alt="OpenClaw"
      loading="lazy"
    />
  );
}

// WorkBuddy icon: 官网抓取的真实应用图标（open.workbuddy.cn favicon，324x324 PNG）
export function WorkBuddyIcon({ size = 16, className = "" }: IconProps) {
  return (
    <img
      src={workbuddyIcon}
      alt=""
      width={size}
      height={size}
      className={cn("inline-block shrink-0 rounded-[4px] object-contain", className)}
      aria-hidden="true"
    />
  );
}

// MCP icon uses inline SVG to support currentColor for hover effects
export function McpIcon({ size = 16, className = "" }: IconProps) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      width={size}
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  );
}

// DeepSeek Harness icon: DeepSeek brand blue rounded square with a white "DS" mark.
export function DeepSeekHarnessIcon({ size = 16, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("inline-block shrink-0 rounded-[4px]", className)}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="24" height="24" rx="5" fill="#4D6BFE" />
      <path
        d="M7.5 8.2h6.1c2 0 3.3 1 3.3 2.6 0 1.2-.7 2-1.9 2.3l2 3.1h-2.5l-1.8-2.9h-2.4v2.9H7.5V8.2zm2.3 1.7v2.6h3.4c.9 0 1.5-.4 1.5-1.3 0-.8-.6-1.3-1.5-1.3h-3.4z"
        fill="#fff"
      />
    </svg>
  );
}
