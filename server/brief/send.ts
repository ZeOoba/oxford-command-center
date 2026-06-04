import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Email } from './render';

const SEND_SCRIPT = process.env.BRIEF_SEND_SCRIPT ?? '_shared/send-via-outlook.ps1';
const OUTBOX = process.env.BRIEF_OUTBOX_DIR ?? 'data/outbox';

export interface SendResult { ok: boolean; via: 'com' | 'outbox'; error?: string }
interface SendDeps { send?: (email: Email, to: string[]) => Promise<boolean>; outboxDir?: string }

/** Real Outlook COM send via PowerShell. Throws on non-zero exit.
 *  Uses -Body (not -HtmlBody) per send-via-outlook.ps1 param signature. */
async function runOutlookCom(email: Email, to: string[]): Promise<boolean> {
  const args = ['-NoProfile', '-File', SEND_SCRIPT, '-To', to.join(';'), '-Subject', email.subject, '-Body', email.html];
  const r = spawnSync('powershell', args, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Outlook COM exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  return true;
}

function toOutbox(email: Email, dir: string, kind: string): void {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(dir, `${stamp}-${kind}.html`), `<!-- subject: ${email.subject} -->\n${email.html}`);
}

export async function sendEmail(email: Email, to: string[], deps: SendDeps = {}): Promise<SendResult> {
  const send = deps.send ?? runOutlookCom;
  const outboxDir = deps.outboxDir ?? OUTBOX;
  const kind = email.subject.includes('CRITICAL') ? 'alert' : 'brief';
  try {
    await send(email, to);
    return { ok: true, via: 'com' };
  } catch (e) {
    toOutbox(email, outboxDir, kind);
    return { ok: false, via: 'outbox', error: e instanceof Error ? e.message : String(e) };
  }
}
