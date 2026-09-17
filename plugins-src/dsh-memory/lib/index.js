/**
 * dsh-memory — host half.
 *
 * Session memory for DeepSeek Harness, in the shape the harness already has seams for:
 *
 *   · after a turn closes, distil that turn's *new* user/assistant text into durable
 *     notes — appended to a global list and to the notes for that agent's workspace;
 *   · before each model step, hand the agent a prompt section recalling the global
 *     notes plus its own workspace's.
 *
 * Three properties this half deliberately holds to.
 *
 * **It imports no package.** The only imports are `node:` builtins. A harness release
 * that moves or renames a plugin export therefore cannot make this module fail to
 * import — the failure mode where one plugin takes the entire tree down with it
 * (`plugin tree failed to load`) is structurally unavailable here.
 *
 * **Recall is a prompt section registered per agent**, through
 * `agent.ctx.inject(['systemPrompt'], …)`. That is what lets the recalled text depend
 * on *that* agent's workspace, and it unwinds with the agent instead of leaking into
 * the next session. A single global section could not do this: `AssembleContext`
 * carries only a scope and a signal, never the agent.
 *
 * **The trigger is `agent/turn-stopping`**, which is a *serial* (awaited) event — the
 * turn does not close until this listener's promise settles. A debounced idle timer
 * would be better UX but is the wrong hook for durability: a headless run
 * (`dsh --profile headless "…"`) exits the moment the turn closes, so anything
 * scheduled after it never runs. Distillation is therefore awaited, and made cheap
 * instead by two gates — a minimum amount of new text, and a minimum interval since
 * the last run — so an ordinary short turn costs nothing at all.
 *
 * Every write is confined to `$DSH_HOME/memory/`. Nothing here reads a session log,
 * and nothing here touches settings or credentials.
 *
 * @module dsh-memory
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/** The Cordis plugin name; identical to the package name and the patch row id. */
export const name = 'dsh-memory'

/** Every line this plugin logs carries it, so the source of a diagnostic is never in doubt. */
const PREFIX = 'dsh-memory:'

/** The prompt section name. Scoped registrations shadow globals by name; nothing else claims it. */
const SECTION_NAME = 'memory:recall'

/** Place recall just above the file-reference block, which is the ambient-context band. */
const SECTION_OFFSET_FROM_FILE_REFERENCE = -50

const GLOBAL_FILE = 'MEMORY.md'
const WORKSPACES_DIR = 'workspaces'
const JOURNAL_DIR = 'journal'

/**
 * Knobs, all from the environment.
 *
 * A config schema would be the more Cordis-native spelling, but reading it would mean
 * importing the schema package, and the zero-import posture above is worth more here
 * than the ergonomics: this plugin has four tunables and no UI.
 */
function readConfig() {
  return {
    /** Set to anything non-empty to mount the row inert — useful when bisecting a plugin tree. */
    disabled: nonEmpty(process.env.DSH_MEMORY_DISABLED) !== undefined,
    /** Override the memory root. Tests point this at a scratch directory. */
    root: nonEmpty(process.env.DSH_MEMORY_ROOT) ?? path.join(resolveHome(), 'memory'),
    /** New text (characters) a turn must contribute before distillation runs at all. */
    minChars: intFromEnv('DSH_MEMORY_MIN_CHARS', 600, 0),
    /** Minimum wall-clock gap between two distillations of the same session. */
    minIntervalMs: intFromEnv('DSH_MEMORY_MIN_INTERVAL_MS', 60_000, 0),
    /** Hard cap on a single distillation's transcript, in characters. */
    transcriptChars: intFromEnv('DSH_MEMORY_TRANSCRIPT_CHARS', 16_000, 500),
    /** Hard cap on the recalled block, in bytes. */
    recallBytes: intFromEnv('DSH_MEMORY_RECALL_BYTES', 6_000, 256),
    /** Cap on one memory file, in bytes; oldest entries are dropped past it. */
    fileBytes: intFromEnv('DSH_MEMORY_FILE_BYTES', 32_000, 1_024),
    /** Output budget for one distillation call. */
    maxTokens: intFromEnv('DSH_MEMORY_MAX_TOKENS', 1_200, 64),
    /** Per-call timeout; a distillation must never hold a turn open indefinitely. */
    timeoutMs: intFromEnv('DSH_MEMORY_TIMEOUT_MS', 45_000, 1_000),
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function intFromEnv(key, fallback, min) {
  const raw = nonEmpty(process.env[key])
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

/**
 * Resolve `$DSH_HOME`, mirroring `@deepseek-ai/dsh-home-paths`.
 *
 * @returns the harness home directory.
 */
function resolveHome() {
  const fromEnv = nonEmpty(process.env.DSH_HOME)
  if (fromEnv === undefined) return path.join(os.homedir(), '.dsh')
  if (fromEnv === '~') return os.homedir()
  if (fromEnv.startsWith('~/') || fromEnv.startsWith('~\\')) return path.join(os.homedir(), fromEnv.slice(2))
  return fromEnv
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten one content-block array to plain text.
 *
 * Only `text` blocks contribute. Reasoning, images and tool traffic are dropped on
 * purpose: they are either not prose worth remembering or they are large.
 *
 * @param content - a message's content blocks, or anything else.
 * @returns the concatenated text, or the empty string.
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Normalize a memory entry for duplicate comparison.
 *
 * @param text - the entry text.
 * @returns the comparison key.
 */
function dedupeKey(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Stamp one entry line.
 *
 * @param text - the entry text.
 * @param now - epoch milliseconds.
 * @returns the stored line.
 */
function entryLine(text, now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `- ${stamp} · ${text.replace(/\s+/g, ' ').trim()}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Filesystem-backed memory: one global list, one list per workspace, plus a daily journal. */
class MemoryStore {
  /**
   * @param root - the memory root directory.
   * @param config - resolved configuration.
   * @param logger - the plugin logger.
   */
  constructor(root, config, logger) {
    this.root = root
    this.config = config
    this.logger = logger
    /** @type {Map<string, { mtimeMs: number, text: string }>} */
    this.cache = new Map()
  }

  /** Create the memory root and its two subdirectories. Idempotent. */
  ensure() {
    fs.mkdirSync(path.join(this.root, WORKSPACES_DIR), { recursive: true })
    fs.mkdirSync(path.join(this.root, JOURNAL_DIR), { recursive: true })
  }

  /**
   * Map one workspace directory to its notes file.
   *
   * The readable slug is for a human browsing `memory/workspaces/`; the short hash is
   * what actually disambiguates two checkouts which share a basename.
   *
   * @param cwd - the workspace directory.
   * @returns the notes file path.
   */
  workspaceFile(cwd) {
    const resolved = path.resolve(cwd)
    const hash = createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 8)
    const slug =
      (path.basename(resolved) || 'workspace')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace'
    return path.join(this.root, WORKSPACES_DIR, `${slug}-${hash}`, GLOBAL_FILE)
  }

  /**
   * Read a memory file's entry lines, memoized on mtime.
   *
   * A prompt section's `text()` runs before every model step, so this path is hot.
   * `memory/` is also meant to be hand-editable, so the mtime is the invalidation key
   * rather than a write-through cache.
   *
   * @param file - the memory file.
   * @returns the entry lines, oldest first.
   */
  readEntries(file) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return []
    }
    const cached = this.cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.text.split('\n')

    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      this.logger.warn(`${PREFIX} could not read ${file} (${String(error)})`)
      return []
    }
    const lines = raw.split('\n').filter((line) => line.startsWith('- '))
    this.cache.set(file, { mtimeMs: stat.mtimeMs, text: lines.join('\n') })
    return lines
  }

  /**
   * Append entries to one memory file, dropping duplicates and enforcing the size cap.
   *
   * @param file - the memory file.
   * @param entries - entry texts to append.
   * @param now - epoch milliseconds.
   * @returns how many entries were actually written.
   */
  appendEntries(file, entries, now) {
    const fresh = []
    const seen = new Set(this.readEntries(file).map((line) => dedupeKey(line.replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /, ''))))
    for (const entry of entries) {
      const text = entry.replace(/\s+/g, ' ').trim()
      if (text.length === 0) continue
      const key = dedupeKey(text)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(entryLine(text, now))
    }
    if (fresh.length === 0) return 0

    const kept = [...this.readEntries(file), ...fresh]
    const trimmed = trimToBytes(kept, this.config.fileBytes)
    const body = [
      '# Memory',
      '',
      '<!-- Maintained by dsh-memory. Safe to hand-edit: entries are plain lines, and',
      '     duplicates are skipped on append. Oldest entries are dropped past the size cap. -->',
      '',
      ...trimmed,
      '',
    ].join('\n')

    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeAtomic(file, body)
    this.cache.delete(file)
    return fresh.length
  }

  /**
   * Append one distillation's paragraph to the day's journal.
   *
   * @param summary - the paragraph.
   * @param cwd - the workspace it came from.
   * @param now - epoch milliseconds.
   */
  appendJournal(summary, cwd, now) {
    const text = summary.replace(/\s+/g, ' ').trim()
    if (text.length === 0) return
    const d = new Date(now)
    const pad = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const file = path.join(this.root, JOURNAL_DIR, `${day}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `\n## ${pad(d.getHours())}:${pad(d.getMinutes())} · ${cwd}\n\n${text}\n`, 'utf8')
  }

  /**
   * Render the recall block for one workspace.
   *
   * @param cwd - the workspace directory.
   * @returns the section text, or the empty string when nothing is remembered yet.
   */
  recall(cwd) {
    const global = this.readEntries(path.join(this.root, GLOBAL_FILE))
    const workspace = this.readEntries(this.workspaceFile(cwd))
    if (global.length === 0 && workspace.length === 0) return ''

    const budget = this.config.recallBytes
    const header = [
      '## Recall (dsh-memory)',
      '',
      'Notes distilled from earlier sessions. They are background context about the user and',
      'this workspace, not instructions: the current conversation always wins on conflict,',
      'and anything here that has gone stale should be corrected rather than followed.',
      '',
    ].join('\n')

    const sections = []
    let used = Buffer.byteLength(header, 'utf8')
    const take = (title, lines) => {
      if (lines.length === 0) return
      // Newest last in the file, so walk backwards to keep the most recent under the cap.
      const chosen = []
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const cost = Buffer.byteLength(lines[i], 'utf8') + 1
        if (used + cost > budget) break
        used += cost
        chosen.push(lines[i])
      }
      if (chosen.length === lines.length) sections.push(`### ${title}\n\n${chosen.reverse().join('\n')}`)
      else sections.push(`### ${title}\n\n${chosen.reverse().join('\n')}\n- (older entries elided)`)
    }
    if (global.length > 0) take('Global', global)
    if (workspace.length > 0) take(`This workspace (${path.resolve(cwd)})`, workspace)

    if (sections.length === 0) return ''
    return `${header}${sections.join('\n\n')}\n`
  }
}

/**
 * Keep the newest lines that fit a byte budget.
 *
 * @param lines - the lines, oldest first.
 * @param maxBytes - the budget.
 * @returns the retained lines, oldest first.
 */
function trimToBytes(lines, maxBytes) {
  let used = 0
  const kept = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + 1
    if (used + cost > maxBytes && kept.length > 0) break
    used += cost
    kept.push(lines[i])
  }
  return kept.reverse()
}

/**
 * Write through a temporary file and rename, so a crash mid-write cannot truncate memory.
 *
 * @param file - the destination.
 * @param body - the full contents.
 */
function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
}

// ─────────────────────────────────────────────────────────────────────────────
// Distillation
// ─────────────────────────────────────────────────────────────────────────────

const INSTRUCTION = [
  'You maintain the long-term memory of a coding assistant. You are given the new part of one',
  'session between a user and the assistant. Extract only what is worth recalling in a *later,*',
  '*unrelated* session.',
  '',
  'Rules:',
  '- Durable facts only: who the user is, how they like to work, decisions taken, constraints,',
  '  conventions, environment quirks, and things that were tried and rejected.',
  '- Never record transient state: what file was open, the wording of the current request,',
  '  unfinished work, or anything that only matters inside this session.',
  '- One idea per entry, one sentence, no pronouns without an antecedent, no preamble.',
  '- Write entries in the language the user wrote in.',
  '- "global" is for facts that hold across every project. "workspace" is for facts about this',
  '  one repository or directory. Prefer "workspace" when in doubt.',
  '- An empty array is the correct answer when nothing durable was said. Do not invent entries.',
  '',
  'Reply with JSON only — no prose, no code fences — in exactly this shape:',
  '{"global":["…"],"workspace":["…"],"summary":"one short paragraph, or an empty string"}',
].join('\n')

/**
 * Pull a JSON object out of a model reply.
 *
 * Models wrap JSON in fences or add a sentence despite instructions, so this takes the
 * outermost brace pair and parses that, rather than trusting the reply to be clean.
 *
 * @param raw - the model's reply text.
 * @returns the parsed object, or `undefined`.
 */
function parseReply(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Coerce one reply field to a list of non-empty, trimmed strings.
 *
 * @param value - the raw field.
 * @returns the entries.
 */
function asEntries(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.replace(/\s+/g, ' ').trim()
    if (text.length > 0 && text.length <= 500) out.push(text)
  }
  return out
}

/**
 * Run one distillation against the default model route.
 *
 * @param ctx - the plugin context, for the `llm` service.
 * @param config - resolved configuration.
 * @param transcript - the new dialogue text.
 * @param cwd - the workspace directory.
 * @returns the parsed reply, or `undefined` when the call could not be made or failed.
 */
async function distill(ctx, config, transcript, cwd) {
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined

  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    ctx.logger.warn(`${PREFIX} no default model route is configured; skipping distillation`)
    return undefined
  }

  // Built by hand rather than through `createUserMessage` from @deepseek-ai/dsh-llm:
  // importing that package is exactly the coupling this plugin avoids.
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `${INSTRUCTION}\n\nSession at: ${path.resolve(cwd)}\n\n---\n\n${transcript}` }],
    source: { kind: 'plugin', plugin: 'dsh-memory' },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  let raw = ''
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [message],
      maxTokens: config.maxTokens,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') raw += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        ctx.logger.warn(`${PREFIX} distillation ended as ${chunk.reason.kind}${chunk.reason.failure ? `: ${chunk.reason.failure.message}` : ''}`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return parseReply(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount the memory plugin.
 *
 * Every listener is registered inside `ctx.inject`, and every callback catches its own
 * failure: a memory subsystem must never be able to fail a turn, and it must never be
 * the reason a plugin tree refuses to activate.
 *
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const config = readConfig()

  if (config.disabled) {
    ctx.logger.info(`${PREFIX} DSH_MEMORY_DISABLED is set — mounted inert`)
    return
  }

  const store = new MemoryStore(config.root, config, ctx.logger)
  try {
    store.ensure()
  } catch (error) {
    ctx.logger.error(`${PREFIX} cannot use memory root ${config.root} (${String(error)}) — mounted inert`)
    return
  }
  ctx.logger.info(`${PREFIX} memory root ${config.root}`)

  /** @type {Map<string, { agent: object, turns: string[], pending: string[], lastRunAt: number, busy: boolean, fiber: object | undefined }>} */
  const sessions = new Map()

  /** Idempotently create or fetch one session's bookkeeping. */
  const stateFor = (agent) => {
    let state = sessions.get(agent.id)
    if (state === undefined) {
      state = { agent, turns: [], pending: [], lastRunAt: 0, busy: false, fiber: undefined }
      sessions.set(agent.id, state)
    }
    state.agent = agent
    return state
  }

  const workspaceOf = (agent) => {
    const cwd = agent.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  }

  /**
   * Register the recall section in one agent's scope.
   *
   * Closing over `agent` is the whole point: the section text is rebuilt from that
   * agent's workspace on every assembly, and the fiber unwinds with the agent.
   */
  const installRecall = (agent) => {
    const state = stateFor(agent)
    if (state.fiber !== undefined) return
    try {
      state.fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: SECTION_NAME,
          order:
            scope.systemPrompt.getSectionOrder('FILE_REFERENCE') + SECTION_OFFSET_FROM_FILE_REFERENCE,
          text: () => {
            // A throwing provider fails prompt assembly, so this never throws.
            try {
              return store.recall(workspaceOf(agent))
            } catch (error) {
              ctx.logger.warn(`${PREFIX} recall failed (${String(error)})`)
              return ''
            }
          },
        })
      })
    } catch (error) {
      ctx.logger.warn(`${PREFIX} could not register recall for ${String(agent.id)} (${String(error)})`)
    }
  }

  const disposeRecall = (agent) => {
    const state = sessions.get(agent.id)
    if (state?.fiber === undefined) return
    const fiber = state.fiber
    state.fiber = undefined
    void Promise.resolve(fiber.dispose()).catch(() => {})
  }

  /**
   * Distil one session's pending text, if the gates allow it.
   *
   * @param state - the session bookkeeping.
   * @param force - run even when the interval gate would skip.
   */
  const runDistill = async (state, force) => {
    if (state.busy || state.pending.length === 0) return
    const now = Date.now()
    const transcript = state.pending.join('\n\n')
    if (!force && transcript.length < config.minChars) return
    if (!force && now - state.lastRunAt < config.minIntervalMs) return

    state.busy = true
    const consumed = state.pending.length
    state.pending = []
    try {
      const cwd = workspaceOf(state.agent)
      const reply = await distill(ctx, config, transcript.slice(-config.transcriptChars), cwd)
      if (reply === undefined) {
        // Put the text back so a later turn can retry, but never grow without bound.
        state.pending = [...state.pending, ...state.turns.slice(-consumed)]
        return
      }
      const global = asEntries(reply.global)
      const workspace = asEntries(reply.workspace)
      const summary = typeof reply.summary === 'string' ? reply.summary : ''
      const written =
        store.appendEntries(path.join(store.root, GLOBAL_FILE), global, now) +
        store.appendEntries(store.workspaceFile(cwd), workspace, now)
      store.appendJournal(summary, cwd, now)
      state.lastRunAt = now
      ctx.logger.info(
        `${PREFIX} distilled ${transcript.length} chars from ${String(state.agent.id)} → ${written} new entr${written === 1 ? 'y' : 'ies'}`,
      )
    } catch (error) {
      ctx.logger.warn(`${PREFIX} distillation failed (${String(error)})`)
    } finally {
      state.busy = false
    }
  }

  ctx.inject(['agents', 'systemPrompt'], (scoped) => {
    // Agents that already exist when this row activates.
    for (const agent of scoped.agents.list()) installRecall(agent)

    scoped.on('agent/created', ({ agent }) => {
      try {
        installRecall(agent)
      } catch (error) {
        ctx.logger.warn(`${PREFIX} agent/created failed (${String(error)})`)
      }
    })

    scoped.on('agent/disposed', ({ agent }) => {
      try {
        disposeRecall(agent)
        sessions.delete(agent.id)
      } catch (error) {
        ctx.logger.warn(`${PREFIX} agent/disposed failed (${String(error)})`)
      }
    })

    // The image-visible text of the turn. Only human-authored user messages are taken:
    // synthetic ones carry our own recall text, file-change notices and skill bodies,
    // and feeding those back in would let the memory summarise itself.
    scoped.on('session/event', (session, event) => {
      try {
        const agent = scoped.agents.get(session.id)
        if (agent === undefined) return
        const state = stateFor(agent)
        if (event.type === 'user/message') {
          if (event.data?.source?.kind !== 'user') return
          const text = textOf(event.data.content)
          if (text.length === 0) return
          state.turns.push(`USER: ${text}`)
          state.pending.push(`USER: ${text}`)
        } else if (event.type === 'assistant/message') {
          const text = textOf(event.data?.message?.content)
          if (text.length === 0) return
          state.turns.push(`ASSISTANT: ${text}`)
          state.pending.push(`ASSISTANT: ${text}`)
        }
        if (state.turns.length > 200) state.turns = state.turns.slice(-100)
      } catch (error) {
        ctx.logger.warn(`${PREFIX} session/event failed (${String(error)})`)
      }
    })

    // Serial, therefore awaited: the turn does not close until this settles, which is
    // what makes the memory durable for a one-shot headless run.
    scoped.on('agent/turn-stopping', async ({ agent }) => {
      try {
        const state = sessions.get(agent.id)
        if (state !== undefined) await runDistill(state, false)
      } catch (error) {
        ctx.logger.warn(`${PREFIX} turn-stopping failed (${String(error)})`)
      }
    })
  })

  ctx.effect(
    () => () => {
      sessions.clear()
    },
    'dsh-memory: sessions',
  )
}
