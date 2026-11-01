// Public runtime config.
//
// Everything in this file ends up in the browser, so it must only ever contain PUBLIC values.
// The Supabase URL and anon/publishable key are designed to be public (they're protected by
// Supabase's own rules). NEVER put an Anthropic API key here: it lives only in Supabase secrets.
//
// You normally don't edit this file. The GitHub Pages workflow overwrites it at deploy time from
// the repository *variables* SUPABASE_URL, SUPABASE_ANON_KEY and AI_ENABLED
// (Settings → Secrets and variables → Actions → Variables). See SETUP.md.
export default {
  supabaseUrl: '',
  supabaseAnonKey: '',
  aiEnabled: false,
};
