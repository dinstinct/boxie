import {doc, runTransaction, serverTimestamp} from 'firebase/firestore';
import {createFirebaseSpikeClient} from '../vault-spike/firebase-client';
export const release = 'web-2026-09-11';
export const codes = ['startup', 'sync', 'signin', 'uncaught', 'other'] as const;
export type ReportCode = typeof codes[number];
export function safeCode(value: unknown): ReportCode {return codes.includes(value as ReportCode) ? value as ReportCode : 'other';}
export async function sendReport(kind: 'feedback' | 'diagnostic', message = '', code: ReportCode = 'other') {
  const client = createFirebaseSpikeClient();
  await client?.auth.authStateReady();
  const user = client?.auth.currentUser;
  if (!client || !user || user.isAnonymous) throw new Error('Your cloud session is unavailable. Your draft is preserved; use the email link below.');
  const id = crypto.randomUUID();
  const counter = doc(client.db, 'boxie', user.uid, 'supportState', kind);
  const report = doc(client.db, 'boxie', user.uid, 'supportReports', id);
  await runTransaction(client.db, async tx => {
    const old = await tx.get(counter); const previous = old.data();
    const now = Date.now(); const reset = !previous || now - previous.startedAt.toMillis() >= 86400000;
    if (previous && now - previous.updatedAt.toMillis() < 60000) throw new Error('Please wait a minute before sending another report.');
    if (!reset && previous.count >= 20) throw new Error('Report limit reached. Please email support.');
    tx.set(counter, {count: reset ? 1 : previous!.count + 1, startedAt: reset ? serverTimestamp() : previous!.startedAt, updatedAt:serverTimestamp(), lastId:id});
    tx.set(report, {kind, code:safeCode(code), message:kind === 'feedback' ? message.trim().slice(0,2000) : '', release, platform:'web', createdAt:serverTimestamp()});
  });
}
const reported = new Set<string>();
export function reportFailure(code: ReportCode) {
  try {
    if(localStorage.getItem('boxie-diagnostics-consent') !== 'yes' || reported.has(code)) return;
    reported.add(code);
    void sendReport('diagnostic', '', code).catch(() => undefined);
  } catch { /* Reporting must never break the app. */ }
}
