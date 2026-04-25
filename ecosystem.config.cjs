// PM2 Ecosystem — Production process manager for Mediasoup SFU
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   ← makes it survive reboots

module.exports = {
  apps: [
    {
      name: 'cognitospeak-sfu',
      script: 'server.js',

      // Node.js interpreter args
      node_args: '--env-file=.env.production',

      // Run 1 instance — mediasoup manages worker processes internally per CPU core.
      // DO NOT use cluster mode (instances > 1) with mediasoup: each instance would
      // create its own worker pool, doubling memory use and splitting room state.
      instances: 1,
      exec_mode: 'fork',

      // Give Node.js more heap for 500+ users (adjust to ~70% of your server RAM)
      // e.g. 4GB RAM server → 2.5GB for Node, rest for OS/mediasoup workers
      node_args: '--max-old-space-size=2048 --env-file=.env.production',

      // Auto restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',   // Must stay up at least 10s to count as stable
      restart_delay: 2000, // Wait 2s before restarting

      // Watch: disabled in production (use rolling deploys instead)
      watch: false,

      // Environment — actual secrets in .env.production
      env_production: {
        NODE_ENV: 'production',
      },

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file:  './logs/sfu-out.log',
      error_file: './logs/sfu-error.log',
      merge_logs: true,
      log_type: 'json',

      // Log rotation (requires pm2-logrotate)
      max_size: '50M',
      retain: '7',

      // Graceful shutdown — give 10s for active calls to drain
      kill_timeout: 10000,
      shutdown_with_message: true,   // sends 'shutdown' message before SIGINT

      // Memory leak guard — restart if Node heap exceeds 1.8GB
      max_memory_restart: '1800M',

      // Source maps for better error traces
      source_map_support: false,
    },
  ],
};
