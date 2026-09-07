import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  settingsApi,
  type CcSwitchImportOptions,
  type CcSwitchImportPreview,
  type CcSwitchImportResult,
} from "@/lib/api/settings";

interface ScopeRow {
  key: string;
  optionKey: keyof Omit<CcSwitchImportOptions, "overwriteExisting">;
  labelKey: string;
}

const SCOPES: ScopeRow[] = [
  {
    key: "providers",
    optionKey: "importProviders",
    labelKey: "settings.ccSwitchImport.catProviders",
  },
  {
    key: "mcpServers",
    optionKey: "importMcpServers",
    labelKey: "settings.ccSwitchImport.catMcpServers",
  },
  {
    key: "universalProviders",
    optionKey: "importUniversalProviders",
    labelKey: "settings.ccSwitchImport.catUniversalProviders",
  },
  {
    key: "prompts",
    optionKey: "importPrompts",
    labelKey: "settings.ccSwitchImport.catPrompts",
  },
  {
    key: "skills",
    optionKey: "importSkills",
    labelKey: "settings.ccSwitchImport.catSkills",
  },
  {
    key: "skillRepos",
    optionKey: "importSkillRepos",
    labelKey: "settings.ccSwitchImport.catSkillRepos",
  },
];

interface CcSwitchImportSectionProps {
  onImportSuccess?: () => void | Promise<void>;
}

export function CcSwitchImportSection({
  onImportSuccess,
}: CcSwitchImportSectionProps) {
  const { t } = useTranslation();

  const [isDetecting, setIsDetecting] = useState(false);
  const [preview, setPreview] = useState<CcSwitchImportPreview | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<CcSwitchImportResult | null>(null);

  const detect = useCallback(async () => {
    setIsDetecting(true);
    setPreview(null);
    setResult(null);
    try {
      const data = await settingsApi.ccSwitchImportPreview();
      if (data.found && data.tables) {
        // 默认全选有可导入数据的类别
        const next: Record<string, boolean> = {};
        for (const row of SCOPES) {
          const table =
            row.key === "universalProviders"
              ? data.universalProviders
              : data.tables[row.key];
          next[row.optionKey] = !!table && !table.missingTable;
        }
        setSelected(next);
      }
      setPreview(data);
    } catch (error) {
      console.error("[CcSwitchImport] Preview failed", error);
      toast.error(
        t("settings.ccSwitchImport.detectFailed", {
          defaultValue: "检测 CC Switch 数据失败",
        }),
      );
    } finally {
      setIsDetecting(false);
    }
  }, [t]);

  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );

  const buildOptions = useCallback(
    (): CcSwitchImportOptions => ({
      importProviders: !!selected.importProviders,
      importMcpServers: !!selected.importMcpServers,
      importPrompts: !!selected.importPrompts,
      importSkills: !!selected.importSkills,
      importSkillRepos: !!selected.importSkillRepos,
      importUniversalProviders: !!selected.importUniversalProviders,
      overwriteExisting,
    }),
    [overwriteExisting, selected],
  );

  const execute = useCallback(async () => {
    setIsImporting(true);
    try {
      const data = await settingsApi.ccSwitchImportExecute(buildOptions());
      setResult(data);
      setShowConfirm(false);
      toast.success(t("settings.ccSwitchImport.importSuccess"), {
        closeButton: true,
      });
      void onImportSuccess?.();
    } catch (error) {
      console.error("[CcSwitchImport] Execute failed", error);
      toast.error(
        t("settings.ccSwitchImport.importFailed", {
          defaultValue: "导入失败：{{message}}",
          message: error instanceof Error ? error.message : String(error ?? ""),
        }),
        { closeButton: true },
      );
    } finally {
      setIsImporting(false);
    }
  }, [buildOptions, onImportSuccess, t]);

  const hasAnyImportable =
    !!preview?.tables &&
    Object.values(preview.tables).some(
      (v) => !v.missingTable && v.sourceCount > 0,
    );

  const renderCount = (
    table:
      | {
          sourceCount: number;
          targetCount: number;
          conflicts: number;
          missingTable?: boolean;
        }
      | undefined,
  ) => {
    if (!table || table.missingTable) {
      return (
        <span className="text-xs text-muted-foreground italic">
          {t("settings.ccSwitchImport.missingTable")}
        </span>
      );
    }
    return (
      <span className="text-xs font-mono">
        {table.sourceCount} / {table.targetCount}
        {table.conflicts > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            {table.conflicts}
          </span>
        )}
      </span>
    );
  };

  return (
    <section className="space-y-4">
      <div className="space-y-4 rounded-lg border border-border bg-muted/40 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <p className="text-sm text-muted-foreground">
              {t("settings.ccSwitchImport.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={detect}
            disabled={isDetecting || isImporting}
            className="flex-shrink-0"
          >
            {isDetecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {isDetecting
              ? t("settings.ccSwitchImport.detecting")
              : t("settings.ccSwitchImport.detect")}
          </Button>
        </div>

        {preview && !preview.found && (
          <div className="flex items-start gap-3 rounded-md border border-border bg-background/60 p-4">
            <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              {t("settings.ccSwitchImport.notFound")}
            </p>
          </div>
        )}

        {preview?.found && preview.tables && (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background/60 divide-y divide-border/60">
              {SCOPES.map((row) => {
                const table =
                  row.key === "universalProviders"
                    ? preview.universalProviders
                    : preview.tables?.[row.key];
                const selectable = !!table && !table.missingTable;
                return (
                  <label
                    key={row.key}
                    className={`flex items-center justify-between gap-3 px-4 py-2.5 ${selectable ? "cursor-pointer" : "opacity-60"}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Checkbox
                        checked={selectable ? !!selected[row.optionKey] : false}
                        disabled={!selectable}
                        onCheckedChange={(checked) =>
                          setSelected((prev) => ({
                            ...prev,
                            [row.optionKey]: checked === true,
                          }))
                        }
                      />
                      <span className="text-sm font-medium">
                        {t(row.labelKey)}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span className="text-[11px] text-muted-foreground hidden sm:inline">
                        {t("settings.ccSwitchImport.sourceSlashLocal")}
                      </span>
                      {renderCount(table)}
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("settings.ccSwitchImport.strategyLabel")}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={!overwriteExisting ? "default" : "outline"}
                  onClick={() => setOverwriteExisting(false)}
                  disabled={isImporting}
                >
                  {t("settings.ccSwitchImport.strategySkip")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={overwriteExisting ? "default" : "outline"}
                  onClick={() => setOverwriteExisting(true)}
                  disabled={isImporting}
                  className={
                    overwriteExisting
                      ? "bg-amber-500 hover:bg-amber-600 text-white"
                      : ""
                  }
                >
                  {t("settings.ccSwitchImport.strategyOverwrite")}
                </Button>
              </div>
              {overwriteExisting && (
                <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  {t("settings.ccSwitchImport.overwriteWarning")}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground">
                {t("settings.ccSwitchImport.currentNote")}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowConfirm(true)}
                disabled={
                  isImporting || selectedCount === 0 || !hasAnyImportable
                }
              >
                {isImporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {isImporting
                  ? t("settings.ccSwitchImport.importing")
                  : t("settings.ccSwitchImport.import")}
              </Button>
            </div>
          </div>
        )}

        {result?.success && result.results && (
          <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-4">
            <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-success" />
            <div className="space-y-1 text-sm min-w-0">
              {Object.entries(result.results).map(([key, stats]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="font-medium">
                    {t(
                      SCOPES.find((s) => s.key === key)?.labelKey ??
                        "settings.ccSwitchImport.title",
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {t("settings.ccSwitchImport.resultSummary", {
                      imported: stats.imported ?? 0,
                      skipped: stats.skipped ?? 0,
                      overwritten: stats.overwritten ?? 0,
                    })}
                  </span>
                </div>
              ))}
              {result.backupId && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.ccSwitchImport.backupNote", {
                    backupId: result.backupId,
                  })}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent zIndex="alert" className="max-w-md glass border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("settings.ccSwitchImport.confirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 space-y-3 text-sm text-muted-foreground">
            <p>
              {t("settings.ccSwitchImport.confirmMessage", {
                count: selectedCount,
              })}
            </p>
            <p>{t("settings.ccSwitchImport.backupHint")}</p>
            {overwriteExisting && (
              <p className="text-amber-600 dark:text-amber-400">
                {t("settings.ccSwitchImport.overwriteWarning")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowConfirm(false)}
              disabled={isImporting}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={execute} disabled={isImporting}>
              {isImporting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.ccSwitchImport.confirmImport")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
