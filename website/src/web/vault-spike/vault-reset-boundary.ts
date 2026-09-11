export interface VaultResetBoundaryResult {
  cleanupComplete: boolean;
}

/**
 * A vault reset has one irreversible boundary: once the new remote epoch is
 * committed, callers must retain its local key even if best-effort cleanup
 * later fails.
 */
export async function runVaultResetBoundary(options: {
  commit: () => Promise<void>;
  cleanup: () => Promise<void>;
}): Promise<VaultResetBoundaryResult> {
  await options.commit();
  try {
    await options.cleanup();
    return { cleanupComplete: true };
  } catch {
    return { cleanupComplete: false };
  }
}
