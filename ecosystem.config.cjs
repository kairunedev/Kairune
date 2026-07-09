module.exports = {
  apps: [
    {
      name: 'kairune',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        PORT: 3040,
        HOST: '0.0.0.0',
      },
    },
  ],
};
