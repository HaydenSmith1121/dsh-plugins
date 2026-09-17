#!/usr/bin/env node
/**
 * dsh-memory — smoke test.
 *
 * Drives the real `apply()` against a hand-built Cordis context instead of a live
 * harness, so the whole chain the plugin actually depends on is exercised:
 * events in → distillation → files on disk → recall text out.
 *
 * What it does NOT cover is anything only the real runtime can answer: whether the
 * scoped-section registration is accepted, whether `agent/turn-stopping` really is
 * awaited, and whether the `llm.stream` option shape is honoured. Those are covered
 * by the end-to-end run against an isolated `DSH_HOME` (see docs/verification.md).
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-smoke-'))
process.env.DSH_MEMORY_ROOT = root
process.env.DSH_MEMORY_MIN_CHARS = '1'
process.env.DSH_MEMORY_MIN_INTERVAL_MS = '0'
delete process.env.DSH_MEMORY_DISABLED

const mod = await import('../lib/index.js')

// ── harness ──────────────────────────────────────────────────────────────────

/** Build the smallest context `apply` can run against. */
function buildCtx({ llmReply }) {
  const listeners = new Map()
  const services = {
    llm: {
      stream(options) {
        lastOptions = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: llmReply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
  }
  let lastOptions

  const make = (extra = {}) => {
    const ctx = {
      // Expected to be silent on a passing run; anything here is the failure reason,
      // so it goes to stderr rather than being swallowed.
      logger: {
        info() {},
        warn: (...args) => console.error('    warn:', ...args),
        error: (...args) => console.error('    error:', ...args),
      },
      get: (key) => services[key],
      on(event, handler) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => {}
      },
      effect(factory) {
        factory()
        return () => {}
      },
      inject(_names, callback) {
        callback(ctx)
        return { dispose: async () => {} }
      },
      ...extra,
    }
    return ctx
  }
  return { ctx: make(), listeners, getLastOptions: () => lastOptions }
}

const sections = []
const agentsService = {
  list: () => [agent],
  get: (id) => (id === agent.id ? agent : undefined),
}
const systemPromptService = {
  getSectionOrder: () => 900,
  section(definition) {
    sections.push(definition)
    return () => {}
  },
}

const built = buildCtx({
  llmReply:
    'Sure! Here you go:\n```json\n{"global":["用户偏好中文回答"],"workspace":["这个仓库用 pnpm 而非 npm"],"summary":"确认了偏好与包管理器。"}\n```',
})
// The two services `apply` reaches for through inject. The base lookup is captured
// first: `rootCtx` and `built.ctx` are the same object, so delegating to
// `built.ctx.get` after the override would recurse forever.
const rootCtx = built.ctx
const baseGet = built.ctx.get
rootCtx.get = (key) =>
  key === 'agents' ? agentsService : key === 'systemPrompt' ? systemPromptService : baseGet(key)
rootCtx.agents = agentsService
rootCtx.systemPrompt = systemPromptService

// The real `Agent` carries an agent-scoped context (`agent.ctx`); recall is registered
// through it, so the stand-in needs one that shares the same service table.
const agent = {
  id: 'session-smoke-1',
  session: { id: 'session-smoke-1', header: { cwd: 'D:\\work\\demo-project' } },
  ctx: rootCtx,
}

// ── run ──────────────────────────────────────────────────────────────────────

assert.equal(mod.name, 'dsh-memory', 'plugin name')
assert.equal(typeof mod.apply, 'function', 'apply is exported')

mod.apply(rootCtx)

assert.equal(sections.length, 1, 'one recall section was registered for the pre-existing agent')
assert.equal(sections[0].name, 'memory:recall')
assert.equal(sections[0].order, 850, 'recall sits just above FILE_REFERENCE (900)')
assert.equal(sections[0].text(), '', 'recall is empty before anything is remembered')

const emit = (event, ...args) => {
  const list = built.listeners.get(event)
  assert.ok(list !== undefined && list.length > 0, `a listener is registered for ${event}`)
  return Promise.all(list.map((handler) => handler(...args)))
}

await emit('session/event', agent.session, {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '以后都用中文回答我' }], source: { kind: 'user' } },
})
await emit('session/event', agent.session, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '好的' }] } },
})
// Synthetic user messages carry our own recall text; they must not be re-ingested.
await emit('session/event', agent.session, {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '## Recall (dsh-memory) …' }], source: { kind: 'plugin', plugin: 'dsh-memory' } },
})

await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

// ── assert ───────────────────────────────────────────────────────────────────

const globalFile = path.join(root, 'MEMORY.md')
const workspaceFiles = fs.readdirSync(path.join(root, 'workspaces'))
const journalFiles = fs.readdirSync(path.join(root, 'journal'))

assert.ok(fs.existsSync(globalFile), 'global MEMORY.md was written')
assert.equal(workspaceFiles.length, 1, 'exactly one workspace memory directory')
assert.equal(journalFiles.length, 1, 'exactly one journal file')

const globalText = fs.readFileSync(globalFile, 'utf8')
assert.match(globalText, /用户偏好中文回答/, 'global entry landed')
assert.doesNotMatch(globalText, /以后都用中文回答我/, 'raw user text is not stored verbatim')

const workspaceText = fs.readFileSync(
  path.join(root, 'workspaces', workspaceFiles[0], 'MEMORY.md'),
  'utf8',
)
assert.match(workspaceText, /这个仓库用 pnpm 而非 npm/, 'workspace entry landed')
assert.match(workspaceFiles[0], /^demo-project-[0-9a-f]{8}$/, 'workspace key is slug + short hash')

const journalText = fs.readFileSync(path.join(root, 'journal', journalFiles[0]), 'utf8')
assert.match(journalText, /确认了偏好与包管理器。/, 'journal paragraph landed')

const options = built.getLastOptions()
assert.equal(options.provider, 'test-provider', 'distillation used the default route provider')
assert.equal(options.model, 'test-model', 'distillation used the default route model')
assert.equal(options.messages.length, 1, 'one message')
assert.match(options.messages[0].content[0].text, /以后都用中文回答我/, 'the transcript reached the model')
assert.doesNotMatch(options.messages[0].content[0].text, /Recall \(dsh-memory\)/, 'the recall block was not fed back in')

const recall = sections[0].text()
assert.match(recall, /## Recall \(dsh-memory\)/, 'recall has a header')
assert.match(recall, /### Global/, 'recall has the global block')
assert.match(recall, /### This workspace/, 'recall has the workspace block')
assert.match(recall, /用户偏好中文回答/, 'recall carries the global entry')
assert.match(recall, /这个仓库用 pnpm 而非 npm/, 'recall carries the workspace entry')

// A second identical turn must not duplicate entries.
await emit('session/event', agent.session, {
  type: 'user/message',
  data: { content: [{ type: 'text', text: '以后都用中文回答我' }], source: { kind: 'user' } },
})
await emit('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal })
const occurrences = fs.readFileSync(globalFile, 'utf8').match(/用户偏好中文回答/g) ?? []
assert.equal(occurrences.length, 1, 'a repeated entry is not appended twice')

fs.rmSync(root, { recursive: true, force: true })
console.log('  ✓ dsh-memory smoke test passed')
