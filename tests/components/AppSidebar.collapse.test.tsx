import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppSidebar,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
} from "@/components/AppSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "app.title" ? "ModelBoard" : key),
  }),
}));

vi.mock("@/components/AppSwitcher", () => ({
  AppGlyph: () => <span data-testid="app-glyph" />,
}));

/**
 * 侧边栏的收起/展开是**受控**的：`collapsed` 由 App 顶部横栏的品牌行按钮驱动，
 * 侧边栏自身不再渲染折叠按钮（历史实现里那个按钮已被移除）。这里锁定两件事：
 * ① 栏宽随 collapsed 切换；② 宽度通过 onWidthChange 上报给横栏对齐装饰层。
 */
describe("AppSidebar collapse (controlled)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  const renderSidebar = (collapsed: boolean, onWidthChange = vi.fn()) => {
    const utils = render(
      <AppSidebar
        activeApp="claude"
        onSwitch={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenHome={vi.fn()}
        collapsed={collapsed}
        onWidthChange={onWidthChange}
      />,
    );
    return { ...utils, onWidthChange };
  };

  it("uses the expanded width and reports it while expanded", () => {
    const { onWidthChange } = renderSidebar(false);

    expect(onWidthChange).toHaveBeenCalledWith(SIDEBAR_EXPANDED_WIDTH);
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-sidebar-width",
      String(SIDEBAR_EXPANDED_WIDTH),
    );
  });

  it("switches to the collapsed width when controlled from outside", () => {
    const onWidthChange = vi.fn();
    const { rerender } = render(
      <AppSidebar
        activeApp="claude"
        onSwitch={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenHome={vi.fn()}
        collapsed={false}
        onWidthChange={onWidthChange}
      />,
    );

    rerender(
      <AppSidebar
        activeApp="claude"
        onSwitch={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenHome={vi.fn()}
        collapsed
        onWidthChange={onWidthChange}
      />,
    );

    expect(onWidthChange).toHaveBeenLastCalledWith(SIDEBAR_COLLAPSED_WIDTH);
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-sidebar-width",
      String(SIDEBAR_COLLAPSED_WIDTH),
    );
  });

  it("hides the app labels when collapsed", () => {
    renderSidebar(true);

    // 收起态只留图标：导航项的文字标签不再渲染
    expect(screen.queryByText("apps.claude")).toBeNull();
  });
});
