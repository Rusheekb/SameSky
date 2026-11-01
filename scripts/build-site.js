// Assemble the static site into an output folder for GitHub Pages and write js/config.js from
// environment variables (set as GitHub repository *variables*, not secrets — they're public).
//
//   SUPABASE_URL=https://xyz.supabase.co SUPABASE_ANON_KEY=... AI_ENABLED=true node scripts/build-site.js _site
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(process.argv[2] || join(ROOT, '_site'));
const INCLUDE = ['index.html', 'manifest.webmanifest', 'assets', 'css', 'js'];

const env = (k) => (process.env[k] || '').trim();
let supabaseUrl = env('SUPABASE_URL').replace(/\/+$/, '');
const supabaseAnonKey = env('SUPABASE_ANON_KEY');

if (supabaseUrl && !/^https:\/\/[a-z0-9.-]+$/i.test(supabaseUrl)) {
  console.warn(`::warning::SUPABASE_URL "${supabaseUrl}" doesn't look like https://<project>.supabase.co — ignoring it.`);
  supabaseUrl = '';
}
if (/^sk-ant-/i.test(supabaseAnonKey) || /^sb_secret_/i.test(supabaseAnonKey) || /service_role/i.test(Buffer.from(supabaseAnonKey.split('.')[1] || '', 'base64').toString())) {
  console.error('::error::SUPABASE_ANON_KEY looks like a SECRET key. Only the anon/publishable key may be used in the website. Aborting.');
  process.exit(1);
}
const hasSupabase = !!(supabaseUrl && supabaseAnonKey);
const aiEnabled = hasSupabase && /^(1|true|yes|on)$/i.test(env('AI_ENABLED'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const entry of INCLUDE) cpSync(join(ROOT, entry), join(OUT, entry), { recursive: true });
writeFileSync(join(OUT, '.nojekyll'), '');

const config = `// Generated at deploy time by scripts/build-site.js. Public values only.
export default ${JSON.stringify({ supabaseUrl: hasSupabase ? supabaseUrl : '', supabaseAnonKey: hasSupabase ? supabaseAnonKey : '', aiEnabled }, null, 2)};
`;
writeFileSync(join(OUT, 'js', 'config.js'), config);

console.log(`Built site in ${OUT}`);
console.log(`  realtime transport: ${hasSupabase ? `Supabase (${supabaseUrl})` : 'PeerJS / WebRTC (no Supabase configured)'}`);
console.log(`  AI prompts: ${aiEnabled ? 'enabled' : 'disabled'}`);
