// Simple syntax test for admin.routes.ts
import { spawn } from 'child_process';

console.log('Testing TypeScript compilation...');

const tsc = spawn('npx', ['tsc', '--noEmit', 'src/routes/admin.routes.ts'], {
  cwd: process.cwd(),
  stdio: 'pipe'
});

let output = '';
let errorOutput = '';

tsc.stdout.on('data', (data) => {
  output += data.toString();
});

tsc.stderr.on('data', (data) => {
  errorOutput += data.toString();
});

tsc.on('close', (code) => {
  if (code === 0) {
    console.log('✅ TypeScript compilation successful - no syntax errors found');
  } else {
    console.log('❌ TypeScript compilation failed:');
    console.log(errorOutput);
    console.log(output);
  }
  process.exit(code);
});
