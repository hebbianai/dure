import { t } from "@/lib/i18n";
import {
  commitPreparedHmuxSessionConversion,
  prepareHmuxSessionConversion,
  type HmuxSessionConversionConfirmation,
  type HmuxSessionConversionWorkflowRequest,
  type PreparedHmuxSessionConversion,
} from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import type { HmuxSessionConversionPaneReceipt } from "@/lib/hmux/conversion/hmuxSessionConversion";

export interface HmuxSessionConversionBatchItem {
  readonly key: string;
  readonly request: HmuxSessionConversionWorkflowRequest;
}

interface HmuxSessionConversionBatchFailure {
  readonly key: string;
  readonly error: unknown;
}

export interface HmuxSessionConversionBatchResult {
  readonly accepted: boolean;
  readonly preparedCount: number;
  readonly deferredCount: number;
  readonly converted: readonly HmuxSessionConversionPaneReceipt[];
  readonly failures: readonly HmuxSessionConversionBatchFailure[];
}

export interface HmuxSessionConversionBatchDeps {
  prepare: (
    request: HmuxSessionConversionWorkflowRequest,
  ) => Promise<PreparedHmuxSessionConversion>;
  commit: (
    prepared: PreparedHmuxSessionConversion,
  ) => Promise<HmuxSessionConversionPaneReceipt>;
}

const defaultDeps: HmuxSessionConversionBatchDeps = {
  prepare: prepareHmuxSessionConversion,
  commit: commitPreparedHmuxSessionConversion,
};

/**
 * Preview every eligible pane without mutation, ask once, then convert each
 * prepared pane serially. A failure never prevents later independent panes
 * from converging through their own recovery journal.
 */
export async function runHmuxSessionConversionBatch(
  items: readonly HmuxSessionConversionBatchItem[],
  alreadyDeferredCount: number,
  confirm: (
    confirmation: HmuxSessionConversionConfirmation,
  ) => Promise<boolean>,
  overrides: Partial<HmuxSessionConversionBatchDeps> = {},
): Promise<HmuxSessionConversionBatchResult> {
  const deps = { ...defaultDeps, ...overrides };
  const prepared: {
    readonly key: string;
    readonly conversion: PreparedHmuxSessionConversion;
  }[] = [];
  const failures: HmuxSessionConversionBatchFailure[] = [];

  for (const item of items) {
    try {
      prepared.push({
        key: item.key,
        conversion: await deps.prepare(item.request),
      });
    } catch (error) {
      failures.push({ key: item.key, error });
    }
  }

  const deferredCount = alreadyDeferredCount + failures.length;
  if (prepared.length === 0) {
    return {
      accepted: false,
      preparedCount: 0,
      deferredCount,
      converted: [],
      failures,
    };
  }

  const deferredNotice =
    deferredCount > 0
      ? t("hmux.conversion.batchConfirm.deferredNote", {
          n: deferredCount,
        })
      : "";
  const accepted = await confirm({
    title: t("common.hmuxSwitch.title"),
    message: t("hmux.conversion.batchConfirm.message", {
      n: prepared.length,
      deferred: deferredNotice,
    }),
  });
  if (!accepted) {
    return {
      accepted: false,
      preparedCount: prepared.length,
      deferredCount,
      converted: [],
      failures,
    };
  }

  const converted: HmuxSessionConversionPaneReceipt[] = [];
  for (const item of prepared) {
    try {
      converted.push(await deps.commit(item.conversion));
    } catch (error) {
      failures.push({ key: item.key, error });
    }
  }
  return {
    accepted: true,
    preparedCount: prepared.length,
    deferredCount,
    converted,
    failures,
  };
}
