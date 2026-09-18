import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingActivationBrand } from "@/components/proxy/RoutingActivationBrand";

describe("RoutingActivationBrand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays a short particle burst only after the current app activates routing", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <RoutingActivationBrand active={false} contextKey="claude" ready />,
    );

    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();

    rerender(<RoutingActivationBrand active contextKey="claude" ready />);

    expect(
      screen.getByTestId("routing-activation-particles"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("routing-activation-status")).toHaveClass(
      "bg-emerald-500",
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();
  });

  it("does not play activation particles when initial status resolves active", () => {
    const { rerender } = render(
      <RoutingActivationBrand
        active={false}
        contextKey="claude"
        ready={false}
      />,
    );

    rerender(<RoutingActivationBrand active contextKey="claude" ready />);

    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();
  });

  it("clears activation particles when switching app context", () => {
    const { rerender } = render(
      <RoutingActivationBrand active={false} contextKey="claude" ready />,
    );

    rerender(<RoutingActivationBrand active contextKey="claude" ready />);

    expect(
      screen.getByTestId("routing-activation-particles"),
    ).toBeInTheDocument();

    rerender(<RoutingActivationBrand active contextKey="codex" ready />);

    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();
  });

  // 测试环境 i18n 资源为空，文案走 defaultValue 兜底，故断言文案里的稳定子串。
  it("exposes the idle (blue) meaning through a hover tooltip", async () => {
    const user = userEvent.setup();
    render(
      <RoutingActivationBrand
        active={false}
        contextKey="claude"
        appLabel="Claude Desktop"
        ready
      />,
    );

    await user.hover(screen.getByTestId("routing-activation-status"));

    // 圆点本身不该再退化成裸 title（原生提示不可控、无法承载两行释义）
    expect(
      screen.getByTestId("routing-activation-status"),
    ).not.toHaveAttribute("title");

    expect(await screen.findAllByText(/为直连模式/)).not.toHaveLength(0);
    expect(
      screen.getAllByText(/路由与故障转移均不生效/).length,
    ).toBeGreaterThan(0);
  });

  it("explains that routing is active when the dot is green", async () => {
    const user = userEvent.setup();
    render(
      <RoutingActivationBrand active contextKey="claude" ready />,
    );

    await user.hover(screen.getByTestId("routing-activation-status"));

    expect(await screen.findAllByText(/已由本地路由接管/)).not.toHaveLength(0);
    expect(screen.getAllByText(/故障转移生效/).length).toBeGreaterThan(0);
  });

  it("says takeover is unsupported when the app has no routing data plane", async () => {
    const user = userEvent.setup();
    render(
      <RoutingActivationBrand
        active={false}
        contextKey="openclaw"
        appLabel="OpenClaw"
        takeoverSupported={false}
        ready
      />,
    );

    await user.hover(screen.getByTestId("routing-activation-status"));

    expect(
      (await screen.findAllByText(/此应用暂不支持路由接管/)).length,
    ).toBeGreaterThan(0);
  });
});
