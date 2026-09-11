import type { User } from "firebase/auth";
import {
  createFirebaseSpikeClient,
  createRemoteVault,
  getRemoteVaultRoot,
  touchDevice,
  type FirebaseSpikeClient
} from "../vault-spike/firebase-client";
import {
  createAndSaveLocalVault,
  deleteLocalVault,
  loadLocalVault
} from "../vault-spike/local-store";
import { randomBytes, randomId } from "../vault-spike/crypto";
import type { LocalVaultState } from "../vault-spike/types";

export type FirstDeviceVaultResult =
  | { kind: "ready"; created: boolean; local: LocalVaultState }
  | { kind: "pairing_required" }
  | { kind: "stale_device" };

export function defaultOnboardingDeviceName(): string {
  const platform = navigator.userAgent.includes("Mac")
    ? "Mac"
    : navigator.userAgent.includes("iPhone")
      ? "iPhone"
      : navigator.userAgent.includes("Android")
        ? "Android"
        : "Browser";
  const browser = navigator.userAgent.includes("Firefox")
    ? "Firefox"
    : navigator.userAgent.includes("Edg/")
      ? "Edge"
      : navigator.userAgent.includes("Chrome")
        ? "Chrome"
        : navigator.userAgent.includes("Safari")
          ? "Safari"
          : "device";
  return `${platform} · ${browser}`;
}

interface SetupOptions {
  client: FirebaseSpikeClient;
  user: User;
  deviceName?: string;
  allowCreate?: boolean;
}

export async function ensureFirstDeviceVault(options: SetupOptions): Promise<FirstDeviceVaultResult> {
  // Serialize tabs sharing IndexedDB: a losing creator must never remove the winner’s key.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`boxie-vault-setup:${options.user.uid}`, () => setupVault(options));
  }
  return setupVault(options);
}

async function setupVault(options: {
  client: FirebaseSpikeClient;
  user: User;
  deviceName?: string;
  allowCreate?: boolean;
}): Promise<FirstDeviceVaultResult> {
  const [remote, local] = await Promise.all([
    getRemoteVaultRoot(options.client, options.user.uid),
    loadLocalVault(options.user.uid)
  ]);

  if (remote && local) {
    if (remote.activeVaultId !== local.vaultId || remote.epoch !== local.epoch) {
      return { kind: "stale_device" };
    }
    await touchDevice(options.client, local).catch(() => undefined);
    return { kind: "ready", created: false, local };
  }
  if (remote && !local) {
    return { kind: "pairing_required" };
  }
  if (!remote && local) {
    // A local key without its expected remote root indicates an interrupted or
    // externally reset setup. Never overwrite either side automatically.
    return { kind: "stale_device" };
  }

  if (!(options.allowCreate ?? (!import.meta.env.PROD || import.meta.env.VITE_BOXIE_PUBLIC_REGISTRATION === "true"))) {
    throw new Error("Public registration is temporarily paused. Existing users can still sign in and pair devices.");
  }

  const created = await createAndSaveLocalVault({
    uid: options.user.uid,
    vaultId: randomId("vault"),
    epoch: 1,
    vaultKey: randomBytes(32),
    deviceName: options.deviceName ?? defaultOnboardingDeviceName()
  });
  try {
    await createRemoteVault(options.client, created);
  } catch (caught) {
    // A lost response is not proof that creation failed. Keep the only key if
    // the server cannot confirm the outcome; retry can recover the same vault.
    const confirmed = await getRemoteVaultRoot(options.client, options.user.uid);
    if (confirmed?.activeVaultId === created.vaultId && confirmed.epoch === created.epoch) {
      return { kind: "ready", created: true, local: created };
    }
    await deleteLocalVault(options.user.uid);
    throw caught;
  }
  return { kind: "ready", created: true, local: created };
}

export function onboardingFirebaseClient(): FirebaseSpikeClient | null {
  return createFirebaseSpikeClient();
}
