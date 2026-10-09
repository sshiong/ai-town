// Generate the API declarations from the installed Convex template without deploying.
const fs = require('node:fs');
const path = require('node:path');
const packageRoot = path.dirname(require.resolve('convex/package.json'));
const { apiCodegen } = require(path.join(packageRoot, 'dist/cjs/cli/codegen_templates/api.js'));
function modules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '_generated' ? [] : modules(filename);
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.d.ts')
    )
      return [];
    return [path.relative('convex', filename).replaceAll(path.sep, '/').replace(/\.ts$/, '.js')];
  });
}
const result = apiCodegen(modules('convex'), { useTypeScript: false });
fs.writeFileSync(
  'convex/_generated/api.d.ts',
  result.DTS.replace(/[ \t]+$/gm, '').trimEnd() + '\n',
);
fs.writeFileSync('convex/_generated/api.js', result.JS.replace(/[ \t]+$/gm, '').trimEnd() + '\n');
