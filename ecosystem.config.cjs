module.exports = {
    apps: [{
        name: 'valkyrie',
        script: './index.js',
        cwd: '/home/ubuntu/Valkyrie-game-',
        exec_mode: 'fork',
        instances: 1,
        watch: false,
        autorestart: true,
        restart_delay: 5000,
        kill_timeout: 30000,
        // Auth/persistence failures require human diagnosis, not a PM2 loop.
        stop_exit_codes: [78]
    }]
};
