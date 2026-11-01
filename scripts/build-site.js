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

// Anything that looks like a secret must never reach the public website (or the build log).
function looksSecret(v) {
  if (/sk-ant-|sb_secret_/i.test(v)) return true;
  try {
    return /service_role/i.test(Buffer.from(v.split('.')[1] || '', 'base64').toString());
  } catch {
    return false;
  }
}
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'AI_ENABLED']) {
  if (looksSecret(env(k))) {
    console.error(`::error::${k} looks like a SECRET key (Anthropic key, Supabase secret or service_role key). Only public values may be used in the website. Aborting — and rotate that key.`);
    process.exit(1);
  }
}
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$|^https:\/\/[a-z0-9.-]+$/i.test(supabaseUrl)) {
  console.warn("::warning::SUPABASE_URL doesn't look like https://<project-ref>.supabase.co — ignoring it.");
  supabaseUrl = '';
}
const hasSupabase = !!(supabaseUrl && supabaseAnonKey);
const wantsAi = /^(1|true|yes|on)$/i.test(env('AI_ENABLED'));
if (wantsAi && !hasSupabase) {
  console.warn('::warning::AI_ENABLED is set but SUPABASE_URL / SUPABASE_ANON_KEY are missing, so AI stays off. Add them (SETUP.md, section 2).');
}
const aiEnabled = hasSupabase && wantsAi;

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
