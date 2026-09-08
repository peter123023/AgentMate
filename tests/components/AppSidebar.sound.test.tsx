import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/AppSidebar";
import { playTypeClick } from "@/lib/typewriterFeedback";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "app.title" ? "ModelBoard" : key),
  }),
}));

vi.mock("@/lib/typewriterFeedback", () => ({
  playTypeClick: vi.fn(),
  tickVibrate: vi.fn(),
  warmupAudioFeedback: vi.fn(),
}));

vi.mock("@/components/AppSwitcher", () => ({
  AppGlyph: () => <span data-testid="app-glyph" />,
}));

describe("AppSidebar typewriter sound", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays click sounds while erasing on collapse", () => {
    render(
      <AppSidebar activeApp="claude" onSwitch={vi.fn()} onOpenSettings={vi.fn()} onOpenHome={vi.fn()} />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "sidebar.collapse" }));
    });
    // 擦除 10 个字符（100ms/字）+ 余量
    act(() => {
      vi.advanceTimersByTime(10 * 100 + 200);
    });

    expect(playTypeClick).toHaveBeenCalled();
    expect(playTypeClick).toHaveBeenCalledTimes(10);
  });

  it("plays click sounds while typing on expand", () => {
    localStorage.setItem("model-board-sidebar-collapsed", "true");
    render(
      <AppSidebar activeApp="claude" onSwitch={vi.fn()} onOpenSettings={vi.fn()} onOpenHome={vi.fn()} />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "sidebar.expand" }));
    });
    // 打出 10 个字符（45ms/字）+ 余量
    act(() => {
      vi.advanceTimersByTime(10 * 45 + 200);
    });

    expect(playTypeClick).toHaveBeenCalledTimes(10);
  });
});
