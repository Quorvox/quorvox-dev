import { build, context } from 'esbuild';

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  target: 'node18',
  sourcemap: true,
};

if (process.argv.includes('--watch')) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log('слежу за src/...');
} else {
  await build(opts);
  console.log('собрано: dist/extension.js');
}
