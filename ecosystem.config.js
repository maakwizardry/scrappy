module.exports = {
  apps: [
    {
      name: "yp-scraper",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env_file: ".env",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
