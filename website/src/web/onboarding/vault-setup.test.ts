import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { FirebaseSpikeClient } from "../vault-spike/firebase-client";
import type { LocalVaultState, RemoteVaultRoot } from "../vault-spike/types";

const firebaseMocks = vi.hoisted(() => ({
  createRemoteVault: vi.fn(),
  getRemoteVaultRoot: vi.fn(),
  touchDevice: vi.fn(),
  createFirebaseSpikeClient: vi.fn()
}));

const localMocks = vi.hoisted(() => ({
  createAndSaveLocalVault: vi.fn(),
  deleteLocalVault: vi.fn(),
  loadLocalVault: vi.fn()
}));

vi.mock("../vault-spike/firebase-client", () => firebaseMocks);
vi.mock("../vault-spike/local-store", () => localMocks);
vi.mock("../vault-spike/crypto", () => ({
  randomBytes: vi.fn(() => new Uint8Array(32)),
  randomId: vi.fn(() => "vault_generated")
}));

import { ensureFirstDeviceVault } from "./vault-setup";

const client = {} as FirebaseSpikeClient;
const user = { uid: "user-1" } as User;
const local = {
  uid: user.uid,
  vaultId: "vault-1",
  epoch: 1,
  deviceName: "Mac · Safari"
} as LocalVaultState;
const remote = {
  activeVaultId: local.vaultId,
  epoch: local.epoch
} as RemoteVaultRoot;

describe("ensureFirstDeviceVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firebaseMocks.touchDevice.mockResolvedValue(undefined);
    firebaseMocks.createRemoteVault.mockResolvedValue(undefined);
    localMocks.deleteLocalVault.mockResolvedValue(undefined);
  });

  it("reuses the matching device vault without creating another", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue(remote);
    localMocks.loadLocalVault.mockResolvedValue(local);

    await expect(ensureFirstDeviceVault({ client, user })).resolves.toEqual({
      kind: "ready",
      created: false,
      local
    });
    expect(firebaseMocks.touchDevice).toHaveBeenCalledWith(client, local);
    expect(localMocks.createAndSaveLocalVault).not.toHaveBeenCalled();
  });

  it("creates the first device vault automatically", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue(null);
    localMocks.loadLocalVault.mockResolvedValue(null);
    localMocks.createAndSaveLocalVault.mockResolvedValue(local);

    await expect(ensureFirstDeviceVault({
      client,
      user,
      deviceName: "Davide's Mac"
    })).resolves.toEqual({ kind: "ready", created: true, local });
    expect(localMocks.createAndSaveLocalVault).toHaveBeenCalledWith(expect.objectContaining({
      uid: user.uid,
      vaultId: "vault_generated",
      epoch: 1,
      deviceName: "Davide's Mac"
    }));
    expect(firebaseMocks.createRemoteVault).toHaveBeenCalledWith(client, local);
  });

  it("requires pairing when the remote vault exists without a local key", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue(remote);
    localMocks.loadLocalVault.mockResolvedValue(null);

    await expect(ensureFirstDeviceVault({ client, user })).resolves.toEqual({
      kind: "pairing_required"
    });
    expect(localMocks.createAndSaveLocalVault).not.toHaveBeenCalled();
  });

  it("fails closed when local and remote epochs differ", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue({ ...remote, epoch: 2 });
    localMocks.loadLocalVault.mockResolvedValue(local);

    await expect(ensureFirstDeviceVault({ client, user })).resolves.toEqual({
      kind: "stale_device"
    });
    expect(firebaseMocks.touchDevice).not.toHaveBeenCalled();
  });

  it("removes a newly generated local key when remote creation fails", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue(null);
    localMocks.loadLocalVault.mockResolvedValue(null);
    localMocks.createAndSaveLocalVault.mockResolvedValue(local);
    firebaseMocks.createRemoteVault.mockRejectedValue(new Error("transaction failed"));

    await expect(ensureFirstDeviceVault({ client, user })).rejects.toThrow("transaction failed");
    expect(localMocks.deleteLocalVault).toHaveBeenCalledWith(user.uid);
  });
  it("retains the key when server creation succeeded but its acknowledgement was lost", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValueOnce(null).mockResolvedValueOnce(remote);
    localMocks.loadLocalVault.mockResolvedValue(null);
    localMocks.createAndSaveLocalVault.mockResolvedValue(local);
    firebaseMocks.createRemoteVault.mockRejectedValue(new Error("response lost"));
    await expect(ensureFirstDeviceVault({client,user})).resolves.toMatchObject({kind:"ready",local});
    expect(localMocks.deleteLocalVault).not.toHaveBeenCalled();
  });
  it("retains the key when creation cannot be confirmed and blocks closed registration", async () => {
    firebaseMocks.getRemoteVaultRoot.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    localMocks.loadLocalVault.mockResolvedValue(null);
    localMocks.createAndSaveLocalVault.mockResolvedValue(local);
    firebaseMocks.createRemoteVault.mockRejectedValue(new Error("response lost"));
    await expect(ensureFirstDeviceVault({client,user})).rejects.toThrow("offline");
    expect(localMocks.deleteLocalVault).not.toHaveBeenCalled();
    firebaseMocks.getRemoteVaultRoot.mockResolvedValue(null);
    await expect(ensureFirstDeviceVault({client,user,allowCreate:false})).rejects.toThrow("registration is temporarily paused");
  });

});
