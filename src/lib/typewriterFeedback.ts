// 打字机音效与触感反馈：Web Audio 现场合成短促"嗒"声，无需音频文件
let audioCtx: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

/**
 * 播放一声打字"嗒"声（带通滤波的噪声瞬态，频率随机微变模拟机械打字机）。
 * AudioContext 在首次用户点击时创建，符合自动播放策略。
 */
export function playTypeClick(volume = 0.12): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  // 20ms 指数衰减白噪声瞬态
  const length = Math.floor(ctx.sampleRate * 0.02);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2600 + Math.random() * 1200;
  filter.Q.value = 1.2;

  const gain = ctx.createGain();
  gain.gain.value = volume;

  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(now);
}

/** 每字触发的轻微震动（仅支持 Vibration API 的设备生效，桌面端静默忽略） */
export function tickVibrate(durationMs = 8): void {
  try {
    navigator.vibrate?.(durationMs);
  } catch {
    // 不支持则忽略
  }
}
