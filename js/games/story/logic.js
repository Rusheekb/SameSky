// Story Chain — write a tiny story together, one line at a time.
//
// The story starts with a title + opening line (built-in bank, or Claude via `story_start`).
// Players take turns adding the next sentence (players[0] writes first). Either player can drop in
// a "✨ Twist!" narrator line (max 3, never two in a row). After 6 player lines either can write
// "The End"; at 24 lines the book is full and ends by itself. In the ending phase the narrator
// (AI) can write the title + epilogue, or the two of you pick a title. The finished story is shown
// as a keepsake page.
//
// Actions can arrive late (a re-send after a dropped message) or cross the partner's move, so they
// say what they refer to: a line carries its `slot` (player lines the writer could see), the
// narrator's ending and "We'll name it ourselves" carry the ending's `at`. Stale ones are ignored.
//
// Pure + deterministic: no DOM, no Date.now(), no Math.random() — only ctx.now / ctx.random.

import { OPENINGS, TWISTS, END_TITLES, EPILOGUES } from '../../content/story.js';
import { cleanText, sample, pick } from '../../lib/util.js';

export const MAX_LINE = 200; // chars per player line
export const MAX_TWIST = 220; // chars per twist line
export const MAX_TWISTS = 3; // per story
export const MIN_LINES = 6; // player lines before "The End" unlocks
export const MAX_LINES = 24; // hard cap: the book is full
export const LINE_POINTS_CAP = 12; // +1 per player line, up to this many per story
export const FINISH_POINTS = 2;
// ms before a pending AI ending falls back to "name it yourselves". Longer than the AI client's own
// timeout (45 s, js/lib/ai.js), so the narrator's call always settles first while it is pending: it
// either binds the book or (failed/timed out) switches to the title form itself. This fallback is
// for when the presser drops off; either of you can also tap "We'll name it ourselves" any time.
export const NARRATOR_WAIT = 50000;
export const MAX_TITLE = 60;
export const MAX_OPENING = 300;
export const MAX_EPILOGUE = 280;
export const FALLBACK_TITLE = 'A Story for Two';

export const meta = {
  id: 'story',
  title: 'Story Chain',
  emoji: '📖',
  tagline: 'Write a tiny story together, one line at a time.',
  description:
    'Take turns adding the next sentence to a story that starts with a surprise opening. Throw in a ✨ twist when it gets too comfortable, then write “The End” together and keep the finished book.',
  minPlayers: 2,
  ai: { task: 'story_start', label: 'a story opening' },
};

// ---------------------------------------------------------------- helpers

const hasWords = (t) => /[\p{L}\p{N}]/u.test(t || '');

/** cleanText, but cut long text at a word boundary with an ellipsis instead of mid-word. */
export function clip(input, max) {
  if (typeof input !== 'string') return '';
  const t = cleanText(input, 4000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

const QUOTE = /["“”'‘’«»]/;
/** Strip markdown emphasis and quotes that wrap the WHOLE string (AI titles often come quoted). */
function unquote(t) {
  let x = t.replace(/^[*_\s]+|[*_\s]+$/g, '');
  const inner = x.slice(1, -1).replace(/(\p{L})[’'](\p{L})/gu, '$1$2'); // ignore apostrophes
  if (x.length > 2 && QUOTE.test(x[0]) && QUOTE.test(x[x.length - 1]) && !QUOTE.test(inner)) x = x.slice(1, -1).trim();
  return x;
}

export const playerLines = (lines) => lines.filter((l) => !l.twist).length;

/** A player line exactly as the reducer stores it (the view sends and matches the same text). */
export const cleanLine = (text) => cleanText(text, MAX_LINE);

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const statsOf = (count, twists) => `${plural(count, 'line')}${twists ? `, ${plural(twists, 'twist')}` : ''}`;

function nameOf(ctx, i) {
  return ctx.names?.[ctx.players?.[i]] || (i === 0 ? 'Alex' : 'Sam');
}

/** Fill the {A}/{B} placeholders in bank text with the players' names. */
export function fillNames(text, ctx) {
  return text.replace(/\{A\}/g, nameOf(ctx, 0)).replace(/\{B\}/g, nameOf(ctx, 1));
}

/** Validate an AI `story_start` result: { title, opening }. Returns null when unusable. */
export function validStart(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const opening = clip(content.opening, MAX_OPENING);
  if (!hasWords(opening) || opening.length < 12) return null;
  const title = unquote(clip(content.title, MAX_TITLE));
  return { title: hasWords(title) ? title : FALLBACK_TITLE, opening, src: 'ai', oid: null };
}

function pickOpening(ctx, seen) {
  const vibe = ctx.settings?.vibe;
  const all = OPENINGS.map((_, i) => i);
  const inVibe = all.filter((i) => OPENINGS[i].vibe === vibe);
  const base = inVibe.length ? inVibe : all;
  const fresh = base.filter((i) => !seen.includes(i));
  const oid = pick(fresh.length ? fresh : base, ctx.random);
  const o = OPENINGS[oid];
  return { title: fillNames(o.title, ctx), opening: fillNames(o.opening, ctx), src: 'bank', oid };
}

function pickTwist(ctx, seen) {
  const vibe = ctx.settings?.vibe;
  const all = TWISTS.map((_, i) => i).filter((i) => TWISTS[i].vibe === 'any' || TWISTS[i].vibe === vibe);
  const fresh = all.filter((i) => !seen.includes(i));
  return pick(fresh.length ? fresh : all, ctx.random);
}

/** The longest player line — usually the one with the most love put into it. */
function memorableLine(lines) {
  let best = '';
  for (const l of lines) if (!l.twist && l.text.length > best.length) best = l.text;
  return best;
}

// ---------------------------------------------------------------- state

const CARRY0 = { points: 0, summary: '', highlights: [], plays: 0, seenO: [], seenT: [] };

function fresh(ctx, start, carry = CARRY0) {
  const seenO = start.oid == null ? carry.seenO : [...carry.seenO, start.oid].slice(-OPENINGS.length + 1);
  return {
    phase: 'writing', // writing -> ending -> final (-> writing again via "Write another")
    story: carry.plays + 1,
    title: start.title, // working title (from the opening)
    opening: start.opening,
    src: start.src, // 'ai' | 'bank'
    lines: [], // { by, text } player lines and { by, text, twist: true } narrator twists
    // Turns alternate; the first story starts with players[0], later stories take turns starting.
    turn: ctx.players[carry.plays % 2] || ctx.players[0],
    twists: 0,
    // { by, at, auto, narrator: 'pending' | 'off' | 'late', suggest: string[] } + once the narrator's
    // reply arrived late: { pick: its title ('' if none), epilogue }
    ending: null,
    book: null, // { title, epilogue, at, by } once finished
    seenO,
    seenT: carry.seenT,
    gained: 0, // points from this story
    done: false,
    plays: carry.plays,
    points: carry.points,
    summary: carry.summary,
    highlights: carry.highlights,
  };
}

export function init(ctx, opts = {}) {
  return fresh(ctx, validStart(opts.content) || pickOpening(ctx, []));
}

/** An action that names an ending (`at`) which is no longer the current one is stale. */
const staleEnding = (s, a) => a.at != null && a.at !== s.ending?.at;

/** Bind the book: title (typed / narrator / working title), epilogue, points and the recap. */
function bind(s, ctx, a) {
  const typed = unquote(clip(a.title, MAX_TITLE));
  const title = hasWords(typed) ? typed : s.title;
  const epi = clip(a.epilogue, MAX_EPILOGUE);
  const kept = s.ending?.epilogue; // the narrator's epilogue that arrived after you took over
  const epilogue = hasWords(epi) ? epi : hasWords(kept) ? kept : fillNames(pick(EPILOGUES, ctx.random), ctx);
  const plays = s.plays + 1;
  const stats = statsOf(playerLines(s.lines), s.twists);
  const summary =
    plays > 1 ? `Wrote ${plays} stories together — latest: “${title}” (${stats})` : `Wrote “${title}” together (${stats})`;
  const best = memorableLine(s.lines);
  const highlight = clip(best ? `“${title}”: ${best}` : `“${title}”`, 190);
  return {
    ...s,
    phase: 'final',
    ending: null,
    book: { title, epilogue, at: ctx.now, by: a.by },
    done: true,
    plays,
    gained: s.gained + FINISH_POINTS,
    points: s.points + FINISH_POINTS,
    summary,
    highlights: [...s.highlights, highlight].slice(-6),
  };
}

function toEnding(s, ctx, by, ai, auto) {
  const suggest = [s.title, ...sample(END_TITLES.filter((t) => t !== s.title), 3, ctx.random)];
  return { ...s, phase: 'ending', ending: { by, at: ctx.now, auto, narrator: ai ? 'pending' : 'off', suggest } };
}

export function reduce(s, a, ctx) {
  if (!a || typeof a !== 'object' || !ctx.players.includes(a.by)) return s;
  switch (a.type) {
    case 'line': {
      if (s.phase !== 'writing' || a.by !== s.turn || typeof a.text !== 'string') return s;
      // `slot` = how many player lines the writer could see. A line that is re-sent ("Send again"
      // after a lost message) only lands in the slot it was written for, so it never lands twice.
      if (a.slot != null && a.slot !== playerLines(s.lines)) return s;
      const text = cleanLine(a.text);
      if (!hasWords(text)) return s;
      const lines = [...s.lines, { by: a.by, text }];
      const count = playerLines(lines);
      const pts = count <= LINE_POINTS_CAP ? 1 : 0;
      const next = {
        ...s,
        lines,
        turn: ctx.players.find((id) => id !== a.by) || a.by,
        gained: s.gained + pts,
        points: s.points + pts,
      };
      return count >= MAX_LINES ? toEnding(next, ctx, a.by, !!ctx.settings?.ai, true) : next;
    }

    case 'twist': {
      if (s.phase !== 'writing' || s.twists >= MAX_TWISTS) return s;
      const last = s.lines[s.lines.length - 1];
      if (!last || last.twist) return s; // needs a player line first, and never two in a row
      // `at` = story length when the button was tapped. If a twist landed since (the partner was
      // quicker, or a slow AI call), drop this one so a double tap never double-applies.
      if (Number.isInteger(a.at) && a.at >= 0 && s.lines.slice(a.at).some((l) => l.twist)) return s;
      let text = unquote(clip(a.text, MAX_TWIST));
      let seenT = s.seenT;
      if (!hasWords(text) || text.length < 8) {
        const id = pickTwist(ctx, s.seenT);
        text = TWISTS[id].text;
        seenT = [...s.seenT, id].slice(-24);
      }
      return { ...s, lines: [...s.lines, { by: a.by, text, twist: true }], twists: s.twists + 1, seenT };
    }

    case 'end': {
      if (s.phase !== 'writing' || playerLines(s.lines) < MIN_LINES) return s;
      return toEnding(s, ctx, a.by, a.ai === true, false);
    }

    case 'resume': {
      // "Keep writing" — undo an early "The End" (not possible once the book is full).
      if (s.phase !== 'ending' || playerLines(s.lines) >= MAX_LINES) return s;
      return { ...s, phase: 'writing', ending: null };
    }

    case 'manual': {
      // The narrator (AI) failed / was skipped: show the title form to both.
      if (s.phase !== 'ending' || s.ending?.narrator !== 'pending' || staleEnding(s, a)) return s;
      return { ...s, ending: { ...s.ending, narrator: 'off' } };
    }

    case 'narrate': {
      // The narrator's (AI) title + epilogue for THIS ending (`at`). While it's awaited it binds the
      // book. If you already chose to name it yourselves (or it came back too late), it doesn't
      // snatch the title form away: its title becomes the first suggestion, and its epilogue closes
      // the book whichever title you bind.
      if (s.phase !== 'ending' || !s.ending || a.at !== s.ending.at) return s;
      if (s.ending.narrator === 'pending') return bind(s, ctx, a);
      if (s.ending.narrator !== 'off') return s; // already arrived once
      const title = unquote(clip(a.title, MAX_TITLE));
      const epilogue = clip(a.epilogue, MAX_EPILOGUE);
      if (!hasWords(title) && !hasWords(epilogue)) return s;
      const aiTitle = hasWords(title) ? title : '';
      const suggest = aiTitle ? [aiTitle, ...s.ending.suggest.filter((t) => t !== aiTitle)].slice(0, 4) : s.ending.suggest;
      return { ...s, ending: { ...s.ending, narrator: 'late', suggest, pick: aiTitle, epilogue: hasWords(epilogue) ? epilogue : '' } };
    }

    case 'finish': {
      if (s.phase !== 'ending') return s;
      return bind(s, ctx, a);
    }

    case 'again': {
      if (!s.done) return s;
      return fresh(ctx, validStart(a.content) || pickOpening(ctx, s.seenO), s);
    }

    default:
      return s;
  }
}

/** If the narrator never answers (AI slow, or the presser dropped off), let them name it themselves. */
export function tick(s, ctx) {
  if (s.phase === 'ending' && s.ending?.narrator === 'pending' && ctx.now - s.ending.at >= NARRATOR_WAIT) {
    return { ...s, ending: { ...s.ending, narrator: 'off' } };
  }
  return s;
}

/**
 * Recap entry when you leave through ✕ mid-story (core/state.js finishGame). A bound book already
 * has its summary + highlight; a story in progress adds its title, line count and the most
 * memorable line so far on top of any stories finished earlier in this game.
 */
export function summarize(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.lines)) return {};
  const carry = { summary: typeof s.summary === 'string' ? s.summary : '', highlights: Array.isArray(s.highlights) ? s.highlights : [] };
  if (s.done) return carry;
  const plays = Number.isInteger(s.plays) ? s.plays : 0;
  const count = playerLines(s.lines);
  if (!count) {
    // "Write another" with nothing written yet: the finished stories speak for themselves.
    return plays ? carry : { summary: `Opened “${s.title}” — left before the first line`, highlights: carry.highlights };
  }
  const stats = statsOf(count, Number(s.twists) || 0);
  const where = s.phase === 'ending' ? 'not named yet' : 'unfinished';
  const summary =
    plays && carry.summary
      ? `${carry.summary} · then started “${s.title}” (${stats}, ${where})`
      : `Started “${s.title}” together — ${stats}, ${where}`;
  const highlight = clip(`“${s.title}” (${where}): ${memorableLine(s.lines)}`, 190);
  return { summary, highlights: [...carry.highlights, highlight].slice(-6) };
}

/**
 * The writer's line on this device (view-side, never sent anywhere until "Add my line"), checked
 * against the authoritative state after every change so a line that was lost on the way or lost a
 * race is never lost to the writer.
 *   draft = { story, text, sent: null | { from, texts, at }, restored }
 * - `sent.texts` are the texts sent for this turn (a "Send again" may have edited it) and
 *   `sent.from` the line count when first sent. When a line by `me` with one of those texts shows
 *   up from there on, it landed: the box is emptied (unless something new was typed since).
 * - If the story moved on without it (the partner tapped "The End" at the same moment, or the
 *   message was rejected), the text is kept and marked `restored` so the composer shows it again,
 *   e.g. after "Keep writing".
 * Returns the same object when nothing changes.
 */
export function reconcileDraft(d, s, me) {
  if (!d || d.story !== s.story) return { story: s.story, text: '', sent: null, restored: false };
  if (!d.sent) return d;
  const landed = d.sent.texts.map(cleanLine);
  const hit = s.lines.slice(d.sent.from).some((l) => !l.twist && l.by === me && landed.includes(l.text));
  if (hit) return { ...d, text: landed.includes(cleanLine(d.text)) ? '' : d.text, sent: null, restored: false };
  if (s.phase !== 'writing' || s.turn !== me) return { ...d, sent: null, restored: hasWords(d.text) };
  return d;
}

/** Plain-text version of the story (for the AI `story` param and "Copy story"). */
export function storyText(s, names = {}) {
  const parts = [s.opening];
  let para = [];
  const flush = () => {
    if (para.length) parts.push(para.join(' '));
    para = [];
  };
  for (const l of s.lines) {
    if (l.twist) {
      flush();
      parts.push(`✨ ${l.text}`);
    } else para.push(l.text);
  }
  flush();
  if (!s.book) return parts.join('\n\n');
  const by = Object.values(names).filter(Boolean).join(' & ');
  return [`📖 ${s.book.title}`, by ? `by ${by}` : '', '', ...parts.flatMap((p) => [p, '']), s.book.epilogue, '', '— The End —']
    .filter((x, i, arr) => !(x === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}
