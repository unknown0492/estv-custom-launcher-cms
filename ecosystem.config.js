/**
 * PM2 process definition. install-cms.bat starts it, saves the PM2 list and sets PM2 to start with Windows.
 */

module.exports = {
    apps: [ {
        name:   'estv-custom-launcher-cms',
        script: 'server.js',
        cwd:    __dirname,

        instances: 1,
        exec_mode: 'fork',

        autorestart:               true,
        watch:                     false,
        max_restarts:              10,
        min_uptime:                '30s',
        restart_delay:             5000,
        exp_backoff_restart_delay: 2000,
        max_memory_restart:        '300M',
        kill_timeout:              4000,

        env: {
            NODE_ENV: 'production'
        },

        // The app writes its own daily files (logs\cms-YYYY-MM-DD.log); these catch what is printed before that
        error_file: './logs/pm2-error.log',
        out_file:   './logs/pm2-out.log',
        merge_logs: true,
        time:       false
    } ]
};
