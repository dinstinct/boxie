import type {SyncV2Store} from '../mail/sync-v2-store';
/** First-device setup only. Never migrate an existing legacy mailbox implicitly.
 * The canonical baseline contains one immutable identity/T0 record, no mail.
 * Reads after each step make acknowledgement loss and reload safe to retry. */
export async function initializeFirstMailbox(input: {
  sync: Pick<SyncV2Store, 'rollout' | 'transitionRollout'>;
  deviceId: string;
  prepareBaseline: () => Promise<void>;
  verifyBaseline: () => Promise<void>;
}): Promise<void> {
  let control = await input.sync.rollout();
  if (!control) throw new Error('This older vault needs an explicit sync upgrade before setup can continue.');
  if (control.phase === 'active') { await input.verifyBaseline(); return; }
  if (control.migrationOwner !== input.deviceId) throw new Error('Finish initial setup on the device that created this vault, then pair this device.');
  if (control.phase === 'preparing') {
    await input.prepareBaseline();
    await input.verifyBaseline();
    await input.sync.transitionRollout(input.deviceId, 'preparing', 'frozen');
    control = await input.sync.rollout();
  }
  if (control?.phase !== 'frozen' || control.migrationOwner !== input.deviceId) throw new Error('Mailbox setup changed. Reload and retry.');
  await input.verifyBaseline();
  await input.sync.transitionRollout(input.deviceId, 'frozen', 'active');
}
