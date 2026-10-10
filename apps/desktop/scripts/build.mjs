// main / preload / 화면(renderer) / 학생 페이지를 dist/ 로 묶는다.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await Promise.all([
  // 의존 패키지는 묶지 않고 node_modules 에서 불러온다 (electron-builder 가 함께 포장)
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', packages: 'external' }),
  // sandbox 된 preload 는 electron 외 모듈을 require 할 수 없으므로 전부 묶는다
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({
    ...common,
    entryPoints: {
      'renderer/control/control': 'src/renderer/control/control.ts',
      'renderer/overlay/overlay': 'src/renderer/overlay/overlay.ts',
      'renderer/control/capture-worklet': 'src/renderer/audio/capture-worklet.ts',
      'student/student': 'src/student/student.ts',
    },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
  }),
]);

for (const [from, to] of [
  ['src/renderer/control/index.html', 'dist/renderer/control/index.html'],
  ['src/renderer/control/control.css', 'dist/renderer/control/control.css'],
  ['src/renderer/overlay/index.html', 'dist/renderer/overlay/index.html'],
  ['src/renderer/overlay/overlay.css', 'dist/renderer/overlay/overlay.css'],
  ['src/student/index.html', 'dist/student/index.html'],
  ['src/student/student.css', 'dist/student/student.css'],
]) {
  await cp(from, to);
}

if (watch) console.log('--watch 는 지원하지 않습니다. 코드를 바꾼 뒤 다시 빌드하세요.');
