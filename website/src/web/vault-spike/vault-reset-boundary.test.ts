import { describe, expect, it, vi } from "vitest";
import { runVaultResetBoundary } from "./vault-reset-boundary";

describe("runVaultResetBoundary", () => {
  it("reports complete after both the epoch commit and cleanup succeed", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await expect(runVaultResetBoundary({ commit, cleanup })).resolves.toEqual({
      cleanupComplete: true
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects when the epoch commit fails so the caller can restore its old key", async () => {
    const commit = vi.fn().mockRejectedValue(new Error("transaction failed"));
    const cleanup = vi.fn();

    await expect(runVaultResetBoundary({ commit, cleanup })).rejects.toThrow(
      "transaction failed"
    );
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("preserves a committed reset when only best-effort cleanup fails", async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup denied"));

    await expect(runVaultResetBoundary({ commit, cleanup })).resolves.toEqual({
      cleanupComplete: false
    });
  });
});
