'use strict';
// Diagnostic preload for `npm run dev:server` (tsx watch), NOT loaded by dev:server:once.
// Loaded via `--require` before the tsx/server import graph evaluates, so it starts ticking
// even if that graph hangs before printing anything of its own.
//
// Context: tsx watch hung before binding its port twice on 2026-07-08, never reproduced across
// nine follow-up trials (including one deliberately forcing chokidar to traverse the ~547K-file
// .claude/worktrees tree) — see package.json's `//devServerNote` and event_log.md 2026-07-08.
// Root cause undetermined; this stays wired in so a natural recurrence gets captured
// automatically instead of requiring a live catch. Safe to remove once the mystery is closed or
// this has produced no reports for a long stretch of normal use.
//
// Success is defined as "the app's port became reachable" (polled via a real TCP connect, since
// this preload has no visibility into the app's own code) — NOT "N seconds elapsed", so a
// healthy multi-hour dev session never false-positives. Once reachable, the timer stops
// entirely: this file's only job is to catch a startup stall, not monitor a running server.
const fs = require('fs');
const net = require('net');
const path = require('path');

// tsx watch spawns the actual server as a CHILD process — that's where the real startup work
// (and thus the hang risk) lives, but a `--require` CLI flag on the parent does NOT propagate to
// it. NODE_OPTIONS (an env var) DOES propagate via the child's inherited environment, so
// self-augment it here, in the parent, before tsx's watch manager ever calls spawn().
const existingNodeOptions = process.env.NODE_OPTIONS || '';
if (!existingNodeOptions.includes(__filename)) {
  process.env.NODE_OPTIONS = `${existingNodeOptions} --require ${__filename}`.trim();
}

const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'dev-watchdog.log');
const start = Date.now();
const port = Number(process.env.BRAIN_SERVER_PORT || 8911);
const STALL_THRESHOLD_S = 45; // original hangs ran 3+ minutes with zero progress; normal cold starts have taken up to ~20s observed, so 45s has real margin without being noisy.

function log(msg) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()} +${((Date.now() - start) / 1000).toFixed(1)}s pid=${process.pid}] ${msg}\n`);
}
log(`--- preload loaded, port=${port} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}`);

function checkPortReachable(cb) {
  const sock = net.connect({ port, host: '127.0.0.1', timeout: 500 });
  sock.once('connect', () => { sock.destroy(); cb(true); });
  sock.once('error', () => { sock.destroy(); cb(false); });
  sock.once('timeout', () => { sock.destroy(); cb(false); });
}

let reported = false;
let started = false;
const timer = setInterval(() => {
  const elapsed = Number(((Date.now() - start) / 1000).toFixed(1));

  checkPortReachable((reachable) => {
    if (reachable && !started) {
      started = true;
      log(`port ${port} reachable after ${elapsed}s — startup healthy, stopping watchdog`);
      clearInterval(timer);
      return;
    }
    if (started) return;

    let handleCounts = {};
    try {
      for (const h of process._getActiveHandles()) {
        const name = (h.constructor && h.constructor.name) || 'unknown';
        handleCounts[name] = (handleCounts[name] || 0) + 1;
      }
    } catch (e) {
      handleCounts = { error: e.message };
    }
    const mem = process.memoryUsage();
    // Every 1s for the first 20s (the window a normal start settles in), then every 5s while
    // still not up — keeps the log small even if this is a genuine multi-minute stall.
    if (elapsed <= 20 || Math.round(elapsed) % 5 === 0) {
      log(`tick (not yet reachable) handles=${JSON.stringify(handleCounts)} rss=${(mem.rss / 1e6).toFixed(0)}MB`);
    }

    if (!reported && elapsed > STALL_THRESHOLD_S) {
      reported = true;
      try {
        const reportPath = path.join(logDir, `stall-report-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(process.report.getReport(), null, 2));
        log('STALL SUSPECTED (port never became reachable within ' + STALL_THRESHOLD_S + 's) — wrote full diagnostic report to ' + reportPath);
      } catch (e) {
        log('report failed: ' + e.message);
      }
    }
  });
}, 1000);
timer.unref();

process.on('exit', (code) => log('--- exit code=' + code + (started ? '' : ' (port never became reachable)')));
