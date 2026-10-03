const { spawn } = require('child_process');
const fs = require('fs');

const child = spawn('npx', ['next', 'dev'], { 
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
});

const out = fs.openSync('dev-stdout.log', 'w');
const err = fs.openSync('dev-stderr.log', 'w');

child.stdout.on('data', (data) => {
  fs.writeSync(out, data);
});

child.stderr.on('data', (data) => {
  fs.writeSync(err, data);
});

child.on('close', (code) => {
  fs.closeSync(out);
  fs.closeSync(err);
  console.log('Process exited with code:', code);
});
