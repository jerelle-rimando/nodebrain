const { spawn } = require('child_process');
const path = require('path');

const tsx = path.join(__dirname, 'node_modules', '.bin', 'tsx.cmd');
const script = path.join(__dirname, 'src', 'index.ts');

const child = spawn(tsx, [script], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', PORT: '3001' },
  shell: true
});

child.on('exit', (code) => process.exit(code));