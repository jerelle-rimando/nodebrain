module.exports = {
  apps: [{
    name: 'nodebrain',
    script: 'start.js',
    interpreter: 'node',
    cwd: __dirname,
    node_args: '--max-old-space-size=1024',
    env: {
      NODE_ENV: 'development',
      PORT: '3001'
    },
    watch: false,
    autorestart: true,
    max_restarts: 5,
    restart_delay: 10000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}