import { describe, expect, it, vi } from "vitest";
import { ensureBrowserStorageHealth } from "./browser-storage-health";

describe("ensureBrowserStorageHealth", () => {
  it("requests persistence and reports usage without blocking startup", async () => {
    const persist = vi.fn(async () => true);
    await expect(ensureBrowserStorageHealth({
      persisted: async () => false,
      persist,
      estimate: async () => ({ usage: 12_000_000, quota: 2_000_000_000 })
    })).resolves.toEqual({
      persistence: "persistent",
      usageBytes: 12_000_000,
      quotaBytes: 2_000_000_000,
      usageRatio: 0.006,
      warning: null
    });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("warns when storage is best effort or close to its quota", async () => {
    const bestEffort = await ensureBrowserStorageHealth({
      persisted: async () => false,
      persist: async () => false,
      estimate: async () => ({ usage: 10, quota: 100 })
    });
    expect(bestEffort.persistence).toBe("best_effort");
    expect(bestEffort.warning).toContain("may clear");

    const nearlyFull = await ensureBrowserStorageHealth({
      persisted: async () => true,
      estimate: async () => ({ usage: 85, quota: 100 })
    });
    expect(nearlyFull.warning).toContain("above 80%");
  });

  it("degrades to diagnostics-unavailable when the API is absent", async () => {
    await expect(ensureBrowserStorageHealth(undefined)).resolves.toMatchObject({
      persistence: "unavailable",
      usageBytes: null,
      quotaBytes: null
    });
  });
});
