// pm2 process file for the VPS worker. Start with `pm2 start ecosystem.config.cjs`
// (then `pm2 save` and, once per machine, `pm2 startup` so it returns after a
// reboot). See docs/health-monitoring.md → "VPS supervisor".
//
// The one setting that matters for mail: kill_timeout. pm2's default is 1600 ms
// between SIGTERM and SIGKILL. The worker's graceful shutdown (worker/index.ts
// shutdown()) needs longer than that to let an in-flight send finish and hand the
// rest of its batch back to `pending`; killed at 1.6 s it is indistinguishable
// from a crash, and every claimed row waits for the 15-minute sweep. The worker
// bounds its own drain at WORKER_SHUTDOWN_DEADLINE_MS (45 s) and always exits
// before this, so the SIGKILL here is a backstop that should never fire.
/* global module */
module.exports = {
  apps: [
    {
      name: "day3-worker",
      script: "npm",
      args: "run worker",
      cwd: "/opt/day3",
      // Env comes from /opt/day3/.env.worker via worker/load-env.ts; nothing here.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Back off a crash loop instead of hammering Redis/Postgres with reconnects;
      // pm2 grows the delay on repeated fast restarts.
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      min_uptime: "30s",
      kill_timeout: 60000,
      // SIGTERM (not SIGINT) so the drain path is the one the supervisor uses too.
      kill_signal: "SIGTERM",
      // A leak should recycle the process (the drain path runs first), not take
      // the box down with it.
      max_memory_restart: "768M",
      // Timestamp pm2's log lines.
      time: true,
    },
  ],
};
