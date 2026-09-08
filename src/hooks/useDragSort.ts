import { useCallback, useMemo } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Provider } from "@/types";
import { providersApi, type AppId } from "@/lib/api";
import { isProxyAppId } from "@/config/appConfig";

export interface UseDragSortOptions {
  /**
   * 提供后，列表按「应置顶」优先稳定分区：命中的供应商排前面，其余排后面，
   * 各自内部仍沿用既有的 sortIndex / createdAt / name 顺序。
   *
   * 用途：累加型应用（如 WorkBuddy）里"尚未添加到配置"（可添加）的供应商，
   * 应固定沉底展示。命中集随 live 配置变化（添加/移除）重新计算时，会自动
   * 再次分区；手动拖拽仍可自由跨区，并持久化到 sortIndex。
   */
  preferTop?: (provider: Provider) => boolean;
}

export function useDragSort(
  providers: Record<string, Provider>,
  appId: AppId,
  options?: UseDragSortOptions,
) {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const sortedProviders = useMemo(() => {
    const locale =
      i18n.language === "zh"
        ? "zh-CN"
        : i18n.language === "zh-TW"
          ? "zh-TW"
          : "en-US";
    const base = Object.values(providers).sort((a, b) => {
      if (a.sortIndex !== undefined && b.sortIndex !== undefined) {
        return a.sortIndex - b.sortIndex;
      }
      if (a.sortIndex !== undefined) return -1;
      if (b.sortIndex !== undefined) return 1;

      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA && timeB && timeA !== timeB) {
        return timeA - timeB;
      }

      return a.name.localeCompare(b.name, locale);
    });

    const { preferTop } = options ?? {};
    if (!preferTop) return base;

    // 稳定分区：top（已添加）在前，bottom（可添加）在后，各自保持 base 顺序，
    // 这样 partition 本身不改变持久 sortIndex，跨区拖拽依然可用并落盘。
    const top: Provider[] = [];
    const bottom: Provider[] = [];
    for (const provider of base) {
      (preferTop(provider) ? top : bottom).push(provider);
    }
    return [...top, ...bottom];
  }, [providers, i18n.language, options?.preferTop]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = sortedProviders.findIndex(
        (provider) => provider.id === active.id,
      );
      const newIndex = sortedProviders.findIndex(
        (provider) => provider.id === over.id,
      );

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      const reordered = arrayMove(sortedProviders, oldIndex, newIndex);
      const updates = reordered.map((provider, index) => ({
        id: provider.id,
        sortIndex: index,
      }));

      try {
        await providersApi.updateSortOrder(updates, appId);
        await queryClient.invalidateQueries({
          queryKey: ["providers", appId],
        });

        // Routing apps derive failover order from sort_index.
        if (isProxyAppId(appId)) {
          await queryClient.invalidateQueries({
            queryKey: ["failoverQueue", appId],
          });
        }

        // 更新托盘菜单以反映新的排序（失败不影响主操作）
        try {
          await providersApi.updateTrayMenu();
        } catch (trayError) {
          console.error("Failed to update tray menu after sort", trayError);
          // 托盘菜单更新失败不影响排序成功
        }

        toast.success(
          t("provider.sortUpdated", {
            defaultValue: "排序已更新",
          }),
          { closeButton: true },
        );
      } catch (error) {
        console.error("Failed to update provider sort order", error);
        toast.error(
          t("provider.sortUpdateFailed", {
            defaultValue: "排序更新失败",
          }),
        );
      }
    },
    [sortedProviders, appId, queryClient, t],
  );

  return {
    sortedProviders,
    sensors,
    handleDragEnd,
  };
}
