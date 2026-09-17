// server/warehouse/agent-runs.ts — provenance for every LLM-backed pipeline run.
// Without this, "which model version produced this fact, from which input, at what cost" is
// unanswerable, and a silent extraction regression is invisible until someone reads a lease.
import { randomUUID } from 'node:crypto';
import type { WarehouseDb } from './db';

export interface RunMeta {
  pipeline: string;
  model?: string;
  promptVersion?: string;
  inputSha256?: string;
}

export function recordUsage(
  db: WarehouseDb,
  runId: string,
  usage: { tokensIn: number; tokensOut: number; costUsd?: number },
): void {
  db.prepare('UPDATE agent_runs SET tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE run_id = ?').run(
    usage.tokensIn,
    usage.tokensOut,
    usage.costUsd ?? null,
    runId,
  );
}

export async function withAgentRun<T>(
  db: WarehouseDb,
  meta: RunMeta,
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = randomUUID();
  db.prepare(
    `INSERT INTO agent_runs (run_id, pipeline, model, prompt_version, input_sha256, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(
    runId,
    meta.pipeline,
    meta.model ?? null,
    meta.promptVersion ?? null,
    meta.inputSha256 ?? null,
    new Date().toISOString(),
  );

  try {
    const result = await fn(runId);
    db.prepare("UPDATE agent_runs SET status = 'ok', ended_at = ? WHERE run_id = ?").run(
      new Date().toISOString(),
      runId,
    );
    return result;
  } catch (err) {
    db.prepare("UPDATE agent_runs SET status = 'error', error = ?, ended_at = ? WHERE run_id = ?").run(
      err instanceof Error ? err.message : String(err),
      new Date().toISOString(),
      runId,
    );
    throw err;
  }
}
