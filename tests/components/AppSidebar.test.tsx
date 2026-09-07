import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/AppSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/typewriterFeedback", () => ({
  playTypeClick: vi.fn(),
  tickVibrate: vi.fn(),
}));

vi.mock("@/components/AppSwitcher", () => ({
  AppGlyph: () => <span data-testid="app-glyph" />,
}));

const PINNED_KEY = "model-board-sidebar-pinned-apps";

function renderSidebar() {
  const onSwitch = vi.fn();
  render(
    <AppSidebar activeApp="claude" onSwitch={onSwitch} onOpenSettings={vi.fn()} />,
  );
  return { onSwitch };
}

/** 按渲染顺序返回侧边栏各 Agent 项的 aria-label（apps.<id>） */
function itemOrder(): string[] {
  return screen
    .getAllByRole("button", { name: /^apps\./ })
    .map((el) => el.getAttribute("aria-label") ?? "");
}

/** 定位某一项的容器，返回其内部的置顶按钮（首位项无按钮，返回 null） */
function queryPinButtonFor(appLabel: string): HTMLElement | null {
  const item = screen.getByRole("button", { name: appLabel }).closest("div");
  expect(item).not.toBeNull();
  return within(item as HTMLElement).queryByRole("button", {
    name: "sidebar.pin",
  });
}

function pinButtonFor(appLabel: string): HTMLElement {
  const button = queryPinButtonFor(appLabel);
  expect(button).not.toBeNull();
  return button as HTMLElement;
}

describe("AppSidebar pin to top", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders apps in default order when nothing is pinned", () => {
    renderSidebar();
    const order = itemOrder();
    expect(order[0]).toBe("apps.claude");
    expect(order[1]).toBe("apps.claude-desktop");
    expect(order.indexOf("apps.codex")).toBeGreaterThan(
      order.indexOf("apps.claude-desktop"),
    );
  });

  it("hides the pin button on the topmost item", () => {
    renderSidebar();
    // 默认第一位 claude 无置顶按钮，第二位有
    expect(queryPinButtonFor("apps.claude")).toBeNull();
    expect(pinButtonFor("apps.claude-desktop")).not.toBeNull();
  });

  it("moves the pinned app to the top and persists it", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(pinButtonFor("apps.codex"));

    expect(itemOrder()[0]).toBe("apps.codex");
    expect(JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]")).toEqual([
      "codex",
    ]);
    // 置顶后已在最顶，按钮消失
    expect(queryPinButtonFor("apps.codex")).toBeNull();
  });

  it("puts the most recently pinned app first", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(pinButtonFor("apps.codex"));
    await user.click(pinButtonFor("apps.gemini"));

    expect(itemOrder()[0]).toBe("apps.gemini");
    expect(itemOrder()[1]).toBe("apps.codex");
    expect(JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]")).toEqual([
      "gemini",
      "codex",
    ]);
  });

  it("re-pins a displaced app back to the top", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(pinButtonFor("apps.codex"));
    expect(queryPinButtonFor("apps.codex")).toBeNull();

    // gemini 置顶后叠到 codex 上面，codex 不在最顶 → 按钮重新出现
    await user.click(pinButtonFor("apps.gemini"));
    expect(itemOrder()[0]).toBe("apps.gemini");
    expect(pinButtonFor("apps.codex")).not.toBeNull();

    // 再点 codex，回到最顶
    await user.click(pinButtonFor("apps.codex"));
    expect(itemOrder()[0]).toBe("apps.codex");
    expect(itemOrder()[1]).toBe("apps.gemini");
    expect(JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]")).toEqual([
      "codex",
      "gemini",
    ]);
  });

  it("restores pinned order from localStorage on mount", () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(["pi", "hermes"]));
    renderSidebar();

    const order = itemOrder();
    expect(order[0]).toBe("apps.pi");
    expect(order[1]).toBe("apps.hermes");
    expect(order[2]).toBe("apps.claude");
  });

  it("ignores unknown app ids stored in localStorage", () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(["not-an-app", "codex"]));
    renderSidebar();

    const order = itemOrder();
    expect(order[0]).toBe("apps.codex");
    expect(order).not.toContain("apps.not-an-app");
  });

  it("still switches apps after pinning controls are added", async () => {
    const user = userEvent.setup();
    const { onSwitch } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "apps.gemini" }));
    expect(onSwitch).toHaveBeenCalledWith("gemini");
  });
});
