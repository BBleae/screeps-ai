'use strict';
const fs = require('fs');
const path = require('path');
const smoke = fs.readFileSync(path.join(__dirname, 'smoke.js'), 'utf8');
const cut = smoke.indexOf("console.log('== makeBody 预算校验 ==');");
const pre = smoke.slice(0, cut).replace("const MODULE_MAP = {", "const MODULE_MAP = {\n    spawn_old: '../test/_spawn_old.js',");
const body = fs.readFileSync(path.join(__dirname, 'spawn_equiv_body.js'), 'utf8');
fs.writeFileSync(path.join(__dirname, '_equiv_run.js'), pre + '\n' + body);
require('./_equiv_run.js');
