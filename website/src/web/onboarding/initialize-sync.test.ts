import {describe, expect, it} from 'vitest';
import {initializeFirstMailbox} from './initialize-sync';
function fixture() {
  let phase: 'preparing' | 'frozen' | 'active' = 'preparing';
  let prepared = 0;
  let failAcknowledgement = false;
  const input = {deviceId:'first',
    sync:{async rollout(){return {phase, migrationOwner:'first'};},
      async transitionRollout(owner:string, expected:'preparing'|'frozen'|null, next:'preparing'|'frozen'|'active') {
        if(owner !== 'first' || expected !== phase) throw new Error('conflict');
        phase = next;
        if(failAcknowledgement) {failAcknowledgement=false;throw new Error('lost reply');}
      }},
    async prepareBaseline(){prepared++;},
    async verifyBaseline(){if(!prepared) throw new Error('identity missing');}};
  return {input, phase:()=>phase, prepared:()=>prepared, loseReply:()=>{failAcknowledgement=true;}};
}
describe('first mailbox v2 activation',()=>{
  it('commits its immutable identity before enabling v2 and is idempotent',async()=>{
    const f=fixture(); await initializeFirstMailbox(f.input); await initializeFirstMailbox(f.input);
    expect(f.phase()).toBe('active');expect(f.prepared()).toBe(1);
  });
  it('resumes after a lost freeze acknowledgement without rewriting the baseline',async()=>{
    const f=fixture();f.loseReply();await expect(initializeFirstMailbox(f.input)).rejects.toThrow('lost reply');
    expect(f.phase()).toBe('frozen');await initializeFirstMailbox(f.input);expect(f.phase()).toBe('active');expect(f.prepared()).toBe(1);
  });
  it('never activates a missing or unverified identity',async()=>{
    const f=fixture();f.input.verifyBaseline=async()=>{throw new Error('invalid identity');};
    await expect(initializeFirstMailbox(f.input)).rejects.toThrow('invalid identity');expect(f.phase()).toBe('preparing');
  });
  it('refuses another device and refuses implicit migration of a legacy vault',async()=>{
    const f=fixture();await expect(initializeFirstMailbox({...f.input,deviceId:'second'})).rejects.toThrow('created this vault');
    await expect(initializeFirstMailbox({...f.input,sync:{...f.input.sync,rollout:async()=>null}})).rejects.toThrow('explicit sync upgrade');expect(f.prepared()).toBe(0);
  });
});
