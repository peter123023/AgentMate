import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolInstallStatus } from "@/components/providers/ToolInstallStatus";
import { clearToolInstallInfoCache } from "@/hooks/useToolInstallInfo";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const probeToolInstallations = vi.fn();
const getToolVersions = vi.fn();
const runToolLifecycleAction = vi.fn();
const openExternal = vi.fn();

// 组件从 "@/lib/api" 取 settingsApi、hook 从 "@/lib/api/settings" 取，两个入口都 mock，
// 指向同一批 spy，避免两处拿到不同的模块实例。
vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    probeToolInstallations: (...args: unknown[]) =>
      probeToolInstallations(...args),
    getToolVersions: (...args: unknown[]) => getToolVersions(...args),
    runToolLifecycleAction: (...args: unknown[]) =>
      runToolLifecycleAction(...args),
    openExternal: (...args: unknown[]) => openExternal(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    probeToolInstallations: (...args: unknown[]) =>
      probeToolInstallations(...args),
    getToolVersions: (...args: unknown[]) => getToolVersions(...args),
    runToolLifecycleAction: (...args: unknown[]) =>
      runToolLifecycleAction(...args),
    openExternal: (...args: unknown[]) => openExternal(...args),
  },
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn(async () => {}),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

function versionRow(over: Record<string, unknown> = {}) {
  return {
    name: "claude",
    version: "2.0.31",
    latest_version: "2.0.31",
    error: null,
    installed_but_broken: false,
    env_type: "macos",
    wsl_distro: null,
    ...over,
  };
}

function installRow(over: Record<string, unknown> = {}) {
  return {
    path: "/opt/homebrew/bin/claude",
    version: "2.0.31",
    runnable: true,
    error: null,
    source: "Homebrew",
    is_path_default: true,
    ...over,
  };
}

describe("ToolInstallStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // hook 用模块级缓存跨挂载复用，用例之间必须清掉，否则后一个用例会读到前一个的数据。
    clearToolInstallInfoCache();
    getToolVersions.mockResolvedValue([versionRow()]);
    probeToolInstallations.mockResolvedValue([
      { tool: "claude", installs: [installRow()], is_conflict: false },
    ]);
    runToolLifecycleAction.mockResolvedValue(undefined);
  });

  it("renders nothing for apps without a CLI tool (e.g. claude-desktop)", () => {
    const { container } = render(<ToolInstallStatus appId="claude-desktop" />);
    expect(container).toBeEmptyDOMElement();
    expect(getToolVersions).not.toHaveBeenCalled();
  });

  it("shows 'installed' plus the version when the tool is present", async () => {
    render(<ToolInstallStatus appId="claude" />);

    expect(
      await screen.findByText("settings.toolInstalledLabel v2.0.31"),
    ).toBeInTheDocument();
    expect(screen.queryByText("settings.toolInstall")).toBeNull();
  });

  it("clicking the install button installs the missing tool and refreshes", async () => {
    getToolVersions
      .mockResolvedValueOnce([
        versionRow({ version: null, latest_version: null }),
      ])
      .mockResolvedValue([versionRow()]);
    probeToolInstallations.mockResolvedValue([
      { tool: "claude", installs: [], is_conflict: false },
    ]);

    render(<ToolInstallStatus appId="claude" />);

    const installButton = await screen.findByRole("button", {
      name: /settings\.toolInstall/,
    });
    fireEvent.click(installButton);

    await waitFor(() =>
      expect(runToolLifecycleAction).toHaveBeenCalledWith(
        ["claude"],
        "install",
      ),
    );
    expect(
      await screen.findByText("settings.toolInstalledLabel v2.0.31"),
    ).toBeInTheDocument();
  });

  it("surfaces the failure with a manual install command when install fails", async () => {
    getToolVersions.mockResolvedValue([
      versionRow({ version: null, latest_version: null }),
    ]);
    runToolLifecycleAction.mockRejectedValue(new Error("network unreachable"));

    render(<ToolInstallStatus appId="claude" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /settings\.toolInstall/ }),
    );

    // 失败后按钮变成「安装失败」，且自动弹开手动安装指引
    // 失败态在按钮与弹层徽章上都出现，用 findAll 避免「多个匹配」
    const failedLabels = await screen.findAllByText(
      "settings.toolInstallFailedShort",
    );
    expect(failedLabels.length).toBeGreaterThan(0);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("settings.toolManualInstallHint"),
    ).toBeInTheDocument();
    // POSIX 走官方安装脚本、Windows 走 npm，两条都算给了可执行的兜底命令
    expect(
      within(dialog).getByText(
        /claude\.ai\/install\.sh|npm i -g @anthropic-ai\/claude-code/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("settings.toolStatusRetry"),
    ).toBeInTheDocument();
  });

  it("opens the docs via openExternal instead of a plain link", async () => {
    getToolVersions.mockResolvedValue([
      versionRow({ version: null, latest_version: null }),
    ]);
    runToolLifecycleAction.mockRejectedValue(new Error("boom"));

    render(<ToolInstallStatus appId="claude" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /settings\.toolInstall/ }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("settings.toolStatusDocs"));

    expect(openExternal).toHaveBeenCalledWith(
      "https://docs.claude.com/en/docs/claude-code/setup",
    );
  });

  it("treats a present-but-unrunnable binary as broken, not missing", async () => {
    getToolVersions.mockResolvedValue([
      versionRow({ version: null, installed_but_broken: true }),
    ]);

    render(<ToolInstallStatus appId="claude" />);

    fireEvent.click(await screen.findByText("settings.toolStatusBroken"));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("settings.toolStatusRetry"),
    ).toBeInTheDocument();
  });

  it("offers an update inside the popover when a newer version exists", async () => {
    getToolVersions.mockResolvedValue([
      versionRow({ version: "2.0.31", latest_version: "2.1.0" }),
    ]);

    render(<ToolInstallStatus appId="claude" />);

    fireEvent.click(
      await screen.findByText("settings.toolInstalledLabel v2.0.31"),
    );

    const dialog = await screen.findByRole("dialog");
    const updateButton = within(dialog).getByRole("button", {
      name: /settings\.toolUpdate/,
    });
    fireEvent.click(updateButton);

    await waitFor(() =>
      expect(runToolLifecycleAction).toHaveBeenCalledWith(["claude"], "update"),
    );
  });
});
