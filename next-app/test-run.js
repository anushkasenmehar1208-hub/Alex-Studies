const { spawn } = require('child_process');
const child = spawn('npx', ['next', 'dev'], { 
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
});
child.stdout.on('data', (data) => {
  console.log('STDOUT:', data.toString());
});
child.stderr.on('data', (data) => {
  console.log('STDERR:', data.toString());
});
child.on('close', (code) => {
  console.log('Process exited with code:', code);
});
