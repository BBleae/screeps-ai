// 按 docs/game/contributed/advanced_grunt.md 搭建完整流水线：
// clean dist → copy 扁平化（文件夹分隔符→下划线）→ version.js 注入 SCRIPT_VERSION → 上传。
// 凭证用 .env 中的 auth token（grunt-screeps 1.5+ 支持 X-Token 认证），绝不入库。
module.exports = function (grunt) {
    // 把 .env 载入 process.env，凭证不入库
    require('fs')
        .readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .forEach((line) => {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
        });

    // CLI 可覆盖：npx grunt --branch=some-branch --ptr=true
    const branch = grunt.option('branch') || 'default';
    const ptr = grunt.option('ptr') ? true : false;
    const currentdate = new Date();

    grunt.log.subhead('Task Start: ' + currentdate.toLocaleString());
    grunt.log.writeln('Branch: ' + branch);

    grunt.loadNpmTasks('grunt-screeps');
    grunt.loadNpmTasks('grunt-contrib-clean');
    grunt.loadNpmTasks('grunt-contrib-copy');
    grunt.loadNpmTasks('grunt-file-append');

    grunt.initConfig({
        screeps: {
            options: {
                token: process.env.SCREEPS_AUTH_TOKEN,
                branch: branch,
                ptr: ptr,
            },
            dist: {
                src: ['dist/*.js'],
            },
        },

        // 上传前清空 dist
        clean: {
            dist: ['dist'],
        },

        // src → dist，文件夹分隔符换成下划线（Screeps 模块名是扁平的）
        copy: {
            screeps: {
                files: [
                    {
                        expand: true,
                        cwd: 'src/',
                        src: '**',
                        dest: 'dist/',
                        filter: 'isFile',
                        rename: (dest, src) => dest + src.replace(/\//g, '_'),
                    },
                    {
                        src: 'vendor/wheels/layout-2.1.0/MinCut.js',
                        dest: 'dist/MinCut.js',
                    },
                    {
                        src: 'vendor/wheels/layout-2.1.0/RoomVisual.js',
                        dest: 'dist/RoomVisual.js',
                    },
                    {
                        src: 'vendor/wheels/layout-2.1.0/planner.js',
                        dest: 'dist/wheel_layout_planner.js',
                    },
                    {
                        src: 'vendor/wheels/movement-1.0.3/moveMatch.js',
                        dest: 'dist/moveMatch.js',
                    },
                    {
                        src: 'vendor/wheels/movement-1.0.3/超级移动优化.js',
                        dest: 'dist/wheel_movement_engine.js',
                    },
                ],
            },
        },

        // 向空文件 dist/version.js 注入版本时间戳；游戏内 require('version') 可对比部署版本
        file_append: {
            versioning: {
                files: [
                    {
                        append: '\nglobal.SCRIPT_VERSION = ' + currentdate.getTime() + '\n',
                        input: 'dist/version.js',
                    },
                ],
            },
        },
    });

    grunt.registerTask('verify-active-branch', 'Abort unless the upload target is activeWorld', function () {
        if (ptr) {
            grunt.log.writeln('PTR upload: activeWorld preflight skipped.');
            return;
        }
        const done = this.async();
        const token = process.env.SCREEPS_AUTH_TOKEN;
        if (!token) {
            grunt.log.error('SCREEPS_AUTH_TOKEN is missing.');
            done(false);
            return;
        }
        const request = require('https').request({
            hostname: 'screeps.com',
            path: '/api/user/branches',
            method: 'GET',
            headers: { 'X-Token': token },
            timeout: 15000,
        }, (response) => {
            let payload = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { payload += chunk; });
            response.on('end', () => {
                try {
                    if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode);
                    const data = JSON.parse(payload);
                    const active = (data.list || []).find((item) => item.activeWorld);
                    if (!active) throw new Error('activeWorld branch not found');
                    if (active.branch !== branch) {
                        throw new Error('refusing upload to ' + branch + '; activeWorld is ' + active.branch);
                    }
                    grunt.log.ok('Verified activeWorld branch: ' + branch);
                    done();
                } catch (error) {
                    grunt.log.error('Branch preflight failed: ' + error.message);
                    done(false);
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('request timeout')));
        request.on('error', (error) => {
            grunt.log.error('Branch preflight failed: ' + error.message);
            done(false);
        });
        request.end();
    });

    grunt.registerTask('default', ['verify-active-branch', 'clean', 'copy:screeps', 'file_append:versioning', 'screeps']);
};
