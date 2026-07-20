module.exports = {
  apps: [
    {
      name: 'logistics-api',
      script: 'api-server.js',
      cwd: __dirname,
      out_file: './server.log',
      error_file: './server.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
    },
  ],
};
