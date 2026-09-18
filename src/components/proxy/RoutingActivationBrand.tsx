import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const BURST_LIFETIME_MS = 980;

const PARTICLES = [
  { x: -76, y: -16, size: 3, delay: 0.01, color: "#60a5fa" },
  { x: -63, y: 17, size: 2, delay: 0.05, color: "#22d3ee" },
  { x: -51, y: -25, size: 2, delay: 0.09, color: "#34d399" },
  { x: -38, y: 24, size: 4, delay: 0.03, color: "#34d399" },
  { x: -24, y: -19, size: 2, delay: 0.12, color: "#93c5fd" },
  { x: -11, y: 27, size: 3, delay: 0.08, color: "#5eead4" },
  { x: 8, y: -26, size: 3, delay: 0.04, color: "#22d3ee" },
  { x: 19, y: 24, size: 2, delay: 0.13, color: "#34d399" },
  { x: 34, y: -22, size: 4, delay: 0.07, color: "#6ee7b7" },
  { x: 47, y: 21, size: 2, delay: 0.02, color: "#60a5fa" },
  { x: 61, y: -15, size: 3, delay: 0.11, color: "#2dd4bf" },
  { x: 76, y: 13, size: 2, delay: 0.06, color: "#34d399" },
] as const;

interface RoutingActivationBrandProps {
  active: boolean;
  contextKey: string;
  ready: boolean;
  /** 展示名（如「Claude Desktop」），用于 tooltip 文案 */
  appLabel?: string;
  /** 该应用是否具备路由接管能力；false 时用「不支持接管」的解释文案 */
  takeoverSupported?: boolean;
}

/**
 * Keeps the brand's existing blue/emerald status semantics, then adds a
 * short-lived confirmation burst only when the current app successfully
 * transitions from direct mode to route takeover.
 */
export function RoutingActivationBrand({
  active,
  contextKey,
  ready,
  appLabel,
  takeoverSupported = true,
}: RoutingActivationBrandProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const previousState = useRef({ active, contextKey, ready });
  const [burstSequence, setBurstSequence] = useState(0);
  const [showBurst, setShowBurst] = useState(false);

  // tooltip 需要比组件本身更大的命中区：2.5px 的圆点单靠自己几乎点不中。
  // 用一个 12px 的 wrapper 承载 hover/focus，圆点视觉尺寸保持不变。
  const appName = appLabel || t("common.unknown", { defaultValue: "未知" });
  const statusTip = active
    ? t("proxy.routingStatusActiveTip", {
        app: appName,
        defaultValue: `${appName} 已由本地路由接管`,
      })
    : t("proxy.routingStatusIdleTip", {
        app: appName,
        defaultValue: `${appName} 为直连模式`,
      });
  const statusTipHint = active
    ? t("proxy.routingStatusActiveTipDesc", {
        defaultValue:
          "请求经本地代理转发，当前供应商由路由决定，故障转移生效。",
      })
    : takeoverSupported
      ? t("proxy.routingStatusIdleTipDesc", {
          defaultValue:
            "请求直连供应商，未经过本地代理，路由与故障转移均不生效。",
        })
      : t("proxy.routingStatusIdleTipDescUnavailable", {
          defaultValue:
            "请求直连供应商，未经过本地代理。此应用暂不支持路由接管。",
        });

  useEffect(() => {
    const previous = previousState.current;
    const sameContext = previous.contextKey === contextKey;
    const justActivated =
      previous.ready && ready && sameContext && !previous.active && active;
    previousState.current = { active, contextKey, ready };

    if (!ready || !sameContext || !active || prefersReducedMotion) {
      setShowBurst(false);
      return;
    }

    if (!justActivated) return;

    setBurstSequence((sequence) => sequence + 1);
    setShowBurst(true);
    const timeoutId = window.setTimeout(
      () => setShowBurst(false),
      BURST_LIFETIME_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [active, contextKey, prefersReducedMotion, ready]);

  return (
    <div className="relative isolate inline-flex items-center">
      {showBurst && (
        <motion.span
          key={`glow-${burstSequence}`}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-3 -inset-y-2 -z-10 rounded-full bg-emerald-400/20 blur-md"
          initial={{ opacity: 0, scaleX: 0.3, scaleY: 0.65 }}
          animate={{
            opacity: [0, 0.8, 0],
            scaleX: [0.3, 1.05, 1.45],
            scaleY: [0.65, 1, 1.25],
          }}
          transition={{
            duration: 0.82,
            times: [0, 0.24, 1],
            ease: [0.16, 1, 0.3, 1],
          }}
        />
      )}

      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="relative z-10 inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label={`${statusTip}。${statusTipHint}`}
            >
              <motion.span
                data-testid="routing-activation-status"
                className={cn(
                  "block h-2.5 w-2.5 rounded-full transition-colors duration-500",
                  active
                    ? "bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
                    : "bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.4)]",
                )}
                animate={
                  showBurst
                    ? {
                        scale: [1, 0.96, 1.075, 1],
                        y: [0, 1, -1.5, 0],
                        filter: [
                          "drop-shadow(0 0 0 rgba(52, 211, 153, 0))",
                          "drop-shadow(0 0 7px rgba(52, 211, 153, 0.75))",
                          "drop-shadow(0 0 3px rgba(52, 211, 153, 0.28))",
                          "drop-shadow(0 0 0 rgba(52, 211, 153, 0))",
                        ],
                      }
                    : {
                        scale: 1,
                        y: 0,
                        filter: "drop-shadow(0 0 0 rgba(52, 211, 153, 0))",
                      }
                }
                transition={
                  showBurst
                    ? {
                        duration: 0.72,
                        times: [0, 0.13, 0.52, 1],
                        ease: [0.16, 1, 0.3, 1],
                      }
                    : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
                }
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <div className="font-medium">{statusTip}</div>
            <div className="mt-0.5 text-primary-foreground/70">
              {statusTipHint}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showBurst && (
        <motion.span
          key={`particles-${burstSequence}`}
          data-testid="routing-activation-particles"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-0 w-0"
        >
          {PARTICLES.map((particle, index) => (
            <motion.span
              key={`${particle.x}-${particle.y}`}
              className="absolute left-0 top-0 block rounded-full"
              style={{
                width: particle.size,
                height: particle.size,
                backgroundColor: particle.color,
                boxShadow: `0 0 ${particle.size * 2 + 2}px ${particle.color}`,
              }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0.2 }}
              animate={{
                x: [0, particle.x * 0.72, particle.x],
                y: [0, particle.y * 0.62, particle.y],
                opacity: [0, 1, 0],
                scale: [0.2, index % 3 === 0 ? 1.45 : 1, 0.25],
              }}
              transition={{
                duration: 0.66 + (index % 4) * 0.055,
                delay: particle.delay,
                times: [0, 0.2, 1],
                ease: [0.16, 1, 0.3, 1],
              }}
            />
          ))}
        </motion.span>
      )}
    </div>
  );
}
