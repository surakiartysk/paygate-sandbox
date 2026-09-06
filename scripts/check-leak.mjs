#!/usr/bin/env node
/**
 * Vocabulary tripwire.
 *
 * This repository restates an approach developed elsewhere; the approach
 * travelled, the source material did not. This check enforces that mechanically
 * on every push, because a rule nobody can verify is a rule that decays.
 *
 * Added late: this repo was public for its whole life with no check at all,
 * while its two companions had one. Nothing had leaked — the history was
 * scanned before this landed — but the absence was the point, and it is the
 * reason the check now runs in CI rather than on trust.
 *
 * ## Why the words are not in this file
 *
 * They used to be, and that was the bug. This repository is public, so a
 * denylist naming the former employer's services published the exact list it
 * existed to suppress — an index of what to look for, helpfully annotated with
 * `a disallowed term`. The check was leaking its own subject.
 *
 * So the terms live in `.leakwords.json`, which is gitignored and never
 * published. What stays here are the *structural* patterns — a JWT, a real
 * secret, a real-looking email — because those describe shapes rather than
 * names, and publishing "we refuse hardcoded JWTs" tells an onlooker nothing
 * they could use.
 *
 * Without that file the check still runs and still fails on structure; it says
 * loudly that the word list is absent rather than passing in silence, because
 * a tripwire that quietly checks nothing is worse than none at all.
 *
 * ## Matching
 *
 * Word terms are matched loosely on purpose. The original rules were written as
 * `\bword\b`, which matches the bare word and misses `wordService`,
 * `word_service` and `WordService` — the forms a word actually takes once it
 * reaches code, and so the ones most likely to carry it in. Each term is
 * expanded to tolerate camelCase, snake_case, kebab-case, any separator and any
 * suffix, so one entry covers the whole family.
 *
 * A check that cries wolf on line one gets ignored by line two, so terms must
 * still be specific enough to be meaningless outside their source. If a term
 * ever fires on innocent code, narrow the term rather than renaming the code.
 * */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'dist', 'build', 'data'])

const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.env',
  '.example',
])

/**
 * Terms that must never appear. Each entry explains itself so a future reader
 * can judge whether a hit is a real leak or a term that needs narrowing.
 */
/**
 * Turns a plain word into a pattern that survives the spellings code uses.
 *
 * A two-word term must match all of thingManager, thing_manager, thing-manager,
 * ThingManager and thingmanager; a one-word term must match thingService and
 * thing_service, which a plain `\b...\b` did not.
 *
 * Word characters are kept, any run of spaces/dashes/underscores between them
 * becomes "any separator or none", and the trailing `\b` is dropped so a
 * suffix cannot smuggle the word past. A leading boundary stays, so "release"
 * is not caught by "lease".
 */
function looseWord(term) {
  const trimmed = term.trim()
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // A term that is not plain words — a hex colour, a token with punctuation —
  // is matched literally. Splitting it on separators and prefixing `\b` would
  // silently fail: `\b` finds no boundary before `#`, so "#c0ffee" matched
  // nothing at all while appearing to be covered.
  if (!/^[\w\s_-]+$/.test(trimmed)) {
    return new RegExp(escape(trimmed).replace(/,\s*/g, ',\\s*'), 'i')
  }

  const body = trimmed
    .split(/[\s_-]+/)
    .map(escape)
    .join('[-_ .]?')
  return new RegExp(`\\b${body}`, 'i')
}

/**
 * The word list, kept out of this file and out of the repository.
 *
 * Shape: { "terms": [{ "term": "...", "why": "..." }] }. Absent by design on a
 * fresh clone — a contributor who has never worked on the source project has
 * nothing to leak from it, and the structural rules below still apply to them.
 */
const WORDS_FILE = join(ROOT, '.leakwords.json')

function loadWordRules() {
  let raw
  try {
    raw = readFileSync(WORDS_FILE, 'utf8')
  } catch {
    return { rules: [], present: false }
  }

  const parsed = JSON.parse(raw)
  return {
    rules: parsed.terms.map(({ term, why }) => ({ pattern: looseWord(term), why })),
    present: true,
  }
}

const { rules: WORD_RULES, present: WORDS_PRESENT } = loadWordRules()

/**
 * Structural rules — safe to publish, because they name shapes rather than
 * subjects. Knowing that this repo refuses hardcoded JWTs tells a reader
 * nothing about where it came from.
 */
const STRUCTURAL = [
  // A distinctive code idiom rather than a name: it describes a shape, so
  // naming it here gives an onlooker nothing, and it belongs with the rules
  // that survive a fresh clone.
  { pattern: /\bonCreate[A-Z]\w*\s*=\s*new\b/, why: 'a disallowed third-party singleton idiom' },
  {
    pattern:
      /\b[A-Za-z0-9._%+-]+@(?!gear-rental\.test|example\.(com|org))[A-Za-z0-9.-]+\.(com|co\.th|io|net)\b/,
    why: 'real-looking email address',
  },
  {
    pattern:
      /\bhttps?:\/\/(?!127\.0\.0\.1|localhost|json\.schemastore\.org|www\.gnu\.org|opensource\.org|metadata\.google\.internal|169\.254\.169\.254)[a-z0-9.-]*(uat|sit|prod|internal|corp)[a-z0-9.-]*\b/i,
    // metadata.google.internal and 169.254.169.254 are the cloud metadata
    // endpoints this sandbox's SSRF guard exists to block; a test naming them
    // is the guard being verified, not a host leaking out.
    why: 'non-public environment host',
  },
  { pattern: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}/, why: 'hardcoded JWT' },
]

const DENYLIST = [...WORD_RULES, ...STRUCTURAL]

/** Paths exempt from scanning — this file necessarily contains every term. */
const EXEMPT = new Set(['scripts/check-leak.mjs', '.leakwords.json'])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
    } else {
      yield full
    }
  }
}

const findings = []

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (EXEMPT.has(rel)) continue

  const ext = extname(file)
  const isDotfile = /^\.[a-z]/i.test(rel.split('/').pop() ?? '')
  if (!SCAN_EXTENSIONS.has(ext) && !isDotfile) continue

  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    continue
  }

  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const { pattern, why } of DENYLIST) {
      const match = pattern.exec(line)
      if (match) {
        findings.push({ file: rel, line: index + 1, term: match[0].trim(), why })
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`\n✖ check:leak — ${findings.length} finding(s)\n`)
  for (const { file, line, term, why } of findings) {
    console.error(`  ${file}:${line}`)
    console.error(`    matched: ${JSON.stringify(term)}  (${why})\n`)
  }
  console.error('This repo must not carry vocabulary from its source material.')
  console.error('If a pattern is over-broad, narrow it in scripts/check-leak.mjs.\n')
  process.exit(1)
}

/*
 * Absent word list: say so, every time.
 *
 * The alternative is a green tick that checked half of what it claims, which
 * is the failure mode this whole file exists to avoid. It is a warning rather
 * than an error because a contributor with no connection to the source project
 * has nothing to leak from it, and should not be blocked by a file they were
 * never given.
 */
if (!WORDS_PRESENT) {
  console.warn(`⚠ check:leak — structural rules only: ${relative(ROOT, WORDS_FILE)} not found.`)
  console.warn('  Vocabulary is NOT being checked. See the note at the top of this file.\n')
}

console.log(
  WORDS_PRESENT
    ? `✓ check:leak — clean (${WORD_RULES.length} vocabulary + ${STRUCTURAL.length} structural rules)`
    : `✓ check:leak — clean against ${STRUCTURAL.length} structural rules`,
)
