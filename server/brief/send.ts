import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Email } from './render';

const SEND_SCRIPT = process.env.BRIEF_SEND_SCRIPT ?? '_shared/send-via-outlook.ps1';
const OUTBOX = process.env.BRIEF_OUTBOX_DIR ?? 'data/outbox';

export interface SendResult { ok: boolean; via: 'com' | 'outbox'; error?: string }
interface SendDeps { send?: (email: Email, to: string[]) => Promise<boolean>; outboxDir?: string }

/** Real Outlook COM send via PowerShell. Throws on non-zero exit.
 *  Writes HTML to a temp file and passes -BodyFile to avoid the ~32 KB
 *  Windows command-line length cap that would silently truncate large briefs. */
async function runOutlookCom(email: Email, to: string[]): Promise<boolean> {
  const tmpPath = join(tmpdir(), `ora-brief-${randomUUID()}.html`);
  try {
    writeFileSync(tmpPath, email.html, 'utf8');
    const args = [
      '-NoProfile', '-File', SEND_SCRIPT,
      '-To', to.join(';'),
      '-Subject', email.subject,
      '-BodyFile', tmpPath,
      '-BodyFormat', 'html',
    ];
    const r = spawnSync('powershell', args, { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`Outlook COM exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
    return true;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* non-fatal cleanup */ }
  }
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
