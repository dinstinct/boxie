export interface BrowserStorageHealth {
  persistence: "persistent" | "best_effort" | "unavailable";
  usageBytes: number | null;
  quotaBytes: number | null;
  usageRatio: number | null;
  warning: string | null;
}

interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export async function ensureBrowserStorageHealth(
  storage: StorageManagerLike | undefined = browserStorageManager()
): Promise<BrowserStorageHealth> {
  if (!storage) {
    return {
      persistence: "unavailable",
      usageBytes: null,
      quotaBytes: null,
      usageRatio: null,
      warning: "This browser does not expose local storage durability information."
    };
  }

  let persistent = false;
  try {
    persistent = await storage.persisted?.() ?? false;
    if (!persistent) persistent = await storage.persist?.() ?? false;
  } catch {
    // Storage remains usable even when the browser rejects a persistence request.
  }

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const estimate = await storage.estimate?.();
    usageBytes = finiteNonNegative(estimate?.usage);
    quotaBytes = finiteNonNegative(estimate?.quota);
  } catch {
    // Quota visibility is diagnostic only and must never block the mailbox.
  }

  const usageRatio = usageBytes !== null && quotaBytes !== null && quotaBytes > 0
    ? usageBytes / quotaBytes
    : null;
  const warning = usageRatio !== null && usageRatio >= 0.8
    ? "On-device storage is above 80% of the browser quota. Encrypted backup remains available."
    : persistent
      ? null
      : "This browser may clear Boxie’s on-device cache under storage pressure. Encrypted backup remains available.";

  return {
    persistence: persistent ? "persistent" : "best_effort",
    usageBytes,
    quotaBytes,
    usageRatio,
    warning
  };
}

function browserStorageManager(): StorageManagerLike | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.storage;
}

function finiteNonNegative(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
