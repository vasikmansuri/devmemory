import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Integration tests exercise the real built bin (dist/cli.js), so build once before the run. */
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  execSync('npx tsup --silent', { cwd: root, stdio: 'inherit' });
}
