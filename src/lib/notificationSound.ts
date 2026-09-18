import type { AgentNotificationSound } from "@/types";

/**
 * 提示音播放。
 *
 * 用 Web Audio 实时合成，不引入任何音频资源文件——应用体积不变、
 * 也没有跨平台资源路径问题；"system" 走系统级提示音（macOS 上是
 * 标准三全音），其余是合成音色。
 *
 * 所有播放在独立的 AudioContext 里做，失败一律静默吞掉：提示音是
 * 锦上添花，任何情况下都不该影响通知本身。
 */

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!sharedContext) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      sharedContext = new Ctor();
    }
    // 浏览器自动播放策略下，context 可能处于 suspended，尝试唤醒。
    if (sharedContext.state === "suspended") {
      void sharedContext.resume().catch(() => undefined);
    }
    return sharedContext;
  } catch {
    return null;
  }
}

/** 单个音符：在指定起始时间播一个带包络的振荡器。 */
function playTone(
  ctx: AudioContext,
  options: {
    startAt: number;
    frequency: number;
    duration: number;
    type?: OscillatorType;
    gain?: number;
    /** 结束频率（做滑音用），不传则保持 */
    endFrequency?: number;
  },
): void {
  const {
    startAt,
    frequency,
    duration,
    type = "sine",
    gain = 0.12,
    endFrequency,
  } = options;

  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  if (endFrequency !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, endFrequency),
      startAt + duration,
    );
  }

  // 指数衰减包络，听感接近系统通知音，不会突然截断产生咔哒声。
  amp.gain.setValueAtTime(0.0001, startAt);
  amp.gain.exponentialRampToValueAtTime(gain, startAt + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/**
 * 播放指定音效。`sound` 为 "none" 时什么都不做。
 *
 * - system : macOS 标准通知三全音（B5 → F#5，两段）
 * - chime  : 明亮双音（C6 → G6）
 * - bell   : 单音钟响（A5，正弦 + 长衰减）
 * - pop    : 短促上滑（400 → 900Hz，三角波）
 * - success: 三音上行（C5 → E5 → G5）
 */
export function playNotificationSound(sound: AgentNotificationSound): void {
  if (sound === "none") return;

  const ctx = getContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime + 0.01;

    switch (sound) {
      case "system":
        playTone(ctx, {
          startAt: now,
          frequency: 987.77,
          duration: 0.16,
          gain: 0.1,
        });
        playTone(ctx, {
          startAt: now + 0.14,
          frequency: 739.99,
          duration: 0.34,
          gain: 0.1,
        });
        break;
      case "chime":
        playTone(ctx, {
          startAt: now,
          frequency: 1046.5,
          duration: 0.14,
          type: "triangle",
        });
        playTone(ctx, {
          startAt: now + 0.1,
          frequency: 1567.98,
          duration: 0.3,
          type: "triangle",
          gain: 0.09,
        });
        break;
      case "bell":
        playTone(ctx, {
          startAt: now,
          frequency: 880,
          duration: 0.7,
          gain: 0.09,
        });
        break;
      case "pop":
        playTone(ctx, {
          startAt: now,
          frequency: 400,
          endFrequency: 900,
          duration: 0.1,
          type: "triangle",
          gain: 0.13,
        });
        break;
      case "success":
        [523.25, 659.25, 783.99].forEach((frequency, index) => {
          playTone(ctx, {
            startAt: now + index * 0.09,
            frequency,
            duration: 0.22,
            type: "triangle",
            gain: 0.1,
          });
        });
        break;
    }
  } catch {
    // 音频不可用（无输出设备 / 权限限制）：静默忽略。
  }
}
