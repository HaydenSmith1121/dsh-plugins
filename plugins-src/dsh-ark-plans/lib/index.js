/**
 * dsh-ark-plans — host half.
 *
 * This bundle's substance is its `cordis.patch.yml`: it declares the two Volcengine
 * Ark plan lanes (Agent Plan and Coding Plan) as hand-declared provider profiles on
 * the shipped `@deepseek-ai/dsh-llm-pi-ai` adapter, which already implements the
 * OpenAI-compatible protocol both lanes speak. The routes, the model catalogs and
 * the credential references all live in that composition patch — nothing here
 * registers a route, and no wire code ships in this package.
 *
 * On top of the composition this half adds two things a composition cannot report:
 *
 *  1. **Credential readiness.** A declared route whose `apiKeyEnv` resolves to
 *     nothing is a perfectly valid profile — it mounts, it appears in the model
 *     picker, and every request fails later with `MISSING_CREDENTIAL`. So this half
 *     states, once at startup and again whenever one of those references changes,
 *     whether each plan can authenticate.
 *
 *  2. **Subscription quota.** How much of each plan's allowance is spent, and when
 *     it next refreshes, is not on the Ark data plane at all: every `/usage`,
 *     `/quota` and `/subscription` path under `/api/plan/v3` answers 404. The
 *     allowance is served by the **control plane** (OpenTOP) as
 *     `GetAFPUsage` / `GetCodingPlanUsage`, returning per-period `used` / `total` /
 *     `percent` / `reset_at`. Those RPCs authenticate with a Volcengine **SSO/STS
 *     or AK/SK** signature — a plan API key cannot call them. So this half signs
 *     V4 itself, reusing the identity that `arkcli` already established on this
 *     machine, and degrades to an explicit "quota unavailable" state (with the
 *     reason and the remedy) rather than showing a wrong number.
 *
 * Every code path is contained: a diagnostic or a quota fetch must never be able to
 * fail the profile's plugin tree.
 *
 * @module dsh-ark-plans
 */

import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The Cordis plugin name; identical to the package name and the patch row id. */
export const name = 'dsh-ark-plans'

/**
 * The plan lanes this bundle declares. `ref` values are the contract between this
 * module and `cordis.patch.yml`: the patch names them as each route's `apiKeyEnv`,
 * and the web Models page stores a typed key under exactly that reference in
 * `$DSH_HOME/.credentials.yaml`.
 *
 * `action` is the OpenTOP RPC that serves the lane's allowance, and `productKind`
 * is how that lane is named in `arkcli`'s profile (`config.yaml` → `profiles.*.type`),
 * which is what we match on to find the right identity.
 */
const PLANS = [
  {
    label: 'Agent Plan',
    route: 'ark-agent-plan',
    ref: 'ARK_AGENT_PLAN_API_KEY',
    action: 'GetAFPUsage',
    productKind: 'agent-plan',
  },
  {
    label: 'Coding Plan',
    route: 'ark-coding-plan',
    ref: 'ARK_CODING_PLAN_API_KEY',
    action: 'GetCodingPlanUsage',
    productKind: 'coding-plan',
  },
]

/** Every line this plugin logs carries it, so the source of a diagnostic is never in doubt. */
const PREFIX = 'dsh-ark-plans:'

/** Where a user types a key, spelled the same way the harness UI spells it. */
const UI_HINT = '设置 → 模型 (Settings → Models) → 该 provider → API Key'

/** OpenTOP is the control plane; the plan lanes' data plane is a different host entirely. */
const OPENTOP_HOST = 'open.volcengineapi.com'
const OPENTOP_VERSION = '2024-01-01'
const OPENTOP_SERVICE = 'ark'
const REGION = 'cn-beijing'

/** How long a quota snapshot stays fresh before another RPC is issued. */
const CACHE_TTL_MS = 60_000

/** Bound on a single quota RPC, so a hung control plane cannot pin a fiber forever. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The one pathname this plugin's browser half reads.
 *
 * It sits under `/plugins`, the prefix the client-module carrier owns, because the
 * Web server consults its **exact** table before its prefix table — so an exact
 * registration here is served by this plugin and cannot be shadowed by that carrier.
 * Registering it as `exact` rather than a prefix is deliberate too: a prefix would
 * additionally claim every path beneath it.
 */
const QUOTA_ROUTE = '/plugins/dsh-ark-plans/quota'

/** Period labels, in the order a user reads them, with their display names. */
const PERIOD_LABELS = [
  { key: '5h', label: '5 小时' },
  { key: 'session', label: '会话' },
  { key: 'weekly', label: '本周' },
  { key: 'monthly', label: '本月' },
]

/**
 * Locate the identity `arkcli` established, which is the only thing on this machine
 * that can sign for the control plane.
 *
 * This is deliberately a best-effort read of a well-known location rather than a
 * dependency: when `arkcli` was never used, every field comes back undefined and the
 * quota panel explains that instead of failing. We read the SSO-derived STS first
 * (it is what a current `arkcli auth login` produces) and fall back to a long-lived
 * AK/SK pair if one was configured by the older `arkcli config init` path.
 *
 * @returns the signing identity, or `undefined` when none can be read.
 */
async function readIdentity(plan) {
  const root = join(homedir(), '.arkcli')
  let config
  try {
    config = await readFile(join(root, 'config.yaml'), 'utf8')
  } catch {
    return undefined
  }

  // Minimal scalar reads: we only need the tenant's identity key and region, and
  // the `type` of the profile that serves this lane. Parsing the whole YAML here
  // would add a dependency for three strings.
  //
  // The profiles map is scanned by indentation rather than by one regex over the
  // whole file: a profile's body is every following line deeper than its own header,
  // so a lookahead that merely stops at the next two-space key would swallow that
  // key into the previous profile and hide every profile after the first.
  const profileType = plan.productKind
  const lines = config.split(/\r?\n/)
  const collect = []
  let inProfiles = false
  let active = undefined
  let target = undefined
  for (const line of lines) {
    if (/^profiles:\s*$/.test(line)) {
      inProfiles = true
      continue
    }
    if (!inProfiles) continue
    // A non-indented, non-blank line ends the profiles map.
    if (line.trim().length > 0 && !/^\s/.test(line)) break

    const header = line.match(/^ {2}(\S[^:]*):\s*$/)
    if (header !== null) {
      active = { type: undefined, identityKey: undefined, region: undefined }
      collect.push(active)
      continue
    }
    if (active === undefined) continue

    const field = line.match(/^\s{4}(\w+):\s*(\S+)\s*$/)
    if (field === null) continue
    if (field[1] === 'type') active.type = field[2]
    if (field[1] === 'identity_key') active.identityKey = field[2]
    if (field[1] === 'region') active.region = field[2]
  }

  for (const profile of collect) {
    if (profile.type === profileType && profile.identityKey !== undefined) {
      target = profile
      break
    }
  }
  if (target === undefined) return undefined

  const identityKey = target.identityKey
  const region = target.region ?? REGION

  const identityDir = join(root, 'identities', identityKey)

  // Preferred: the SSO-derived STS, which carries a session token.
  try {
    const sts = JSON.parse(await readFile(join(identityDir, 'sts.json'), 'utf8'))
    if (typeof sts.ak === 'string' && typeof sts.sk === 'string') {
      const expiresAt = typeof sts.expires_at === 'number' ? sts.expires_at : undefined
      return {
        ak: sts.ak,
        sk: sts.sk,
        sessionToken: typeof sts.session_token === 'string' ? sts.session_token : undefined,
        region,
        source: 'sso-sts',
        expiresAt,
      }
    }
  } catch {
    // Fall through to AK/SK.
  }

  // Fallback: a long-lived AK/SK pair, used only when it was configured explicitly.
  const ak = config.match(/^\s{4}access_key:\s*(\S+)\s*$/m)?.[1]
  const sk = config.match(/^\s{4}secret_key:\s*(\S+)\s*$/m)?.[1]
  if (ak !== undefined && sk !== undefined) {
    return { ak, sk, sessionToken: undefined, region, source: 'aksk', expiresAt: undefined }
  }
  return undefined
}

/** SHA-256 as lowercase hex. */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** One HMAC-SHA256 round, returning raw bytes so rounds can be chained. */
function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest()
}

/**
 * Call one OpenTOP Action with a Volcengine V4 signature.
 *
 * The Action and Version travel in the query string and the body is JSON, which is
 * the shape OpenTOP uses for its `open` namespace Actions.
 *
 * @param action - the Action name, e.g. `GetAFPUsage`.
 * @param identity - the signing identity read from `arkcli`.
 * @param body - the JSON body; `{}` for these read-only Actions.
 * @returns the decoded response envelope.
 */
async function callOpenTop(action, identity, body = {}) {
  const payload = JSON.stringify(body)
  const payloadHash = sha256Hex(payload)
  const xDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const shortDate = xDate.slice(0, 10)

  const query = `Action=${encodeURIComponent(action)}&Version=${encodeURIComponent(OPENTOP_VERSION)}`
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonicalHeaders =
    `content-type:application/json\n`
    + `host:${OPENTOP_HOST}\n`
    + `x-content-sha256:${payloadHash}\n`
    + `x-date:${xDate}\n`
  const credentialScope = `${shortDate}/${identity.region}/${OPENTOP_SERVICE}/request`
  const canonicalRequest = [
    'POST', '/', query, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')
  const stringToSign = [
    'HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = hmac(
    hmac(hmac(hmac(identity.sk, shortDate), identity.region), OPENTOP_SERVICE),
    'request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization =
    `HMAC-SHA256 Credential=${identity.ak}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const headers = {
    'Content-Type': 'application/json',
    'Host': OPENTOP_HOST,
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: authorization,
  }
  if (identity.sessionToken !== undefined) headers['X-Security-Token'] = identity.sessionToken

  const response = await fetch(`https://${OPENTOP_HOST}/?${query}`, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`OpenTOP ${action} returned non-JSON (HTTP ${response.status})`)
  }
  const error = parsed?.ResponseMetadata?.Error
  if (error !== undefined) {
    throw new Error(`${action} failed: ${error.Code ?? 'Error'} — ${error.Message ?? 'unknown'}`)
  }
  if (!response.ok) throw new Error(`OpenTOP ${action} returned HTTP ${response.status}`)
  return parsed
}

/**
 * Reduce one `used` / `total` pair to the shared period shape.
 *
 * Agent Plan reports absolute units; Coding Plan reports only a percentage, with
 * `used` and `total` absent. Rather than invent the missing two, `used` and `total`
 * stay `null` for that lane and the percentage carries the picture.
 */
function period(label, entry) {
  if (entry === null || entry === undefined) return undefined
  const used = typeof entry.Used === 'number' ? entry.Used : null
  const total = typeof entry.Total === 'number' ? entry.Total : null
  const percent = typeof entry.Percent === 'number'
    ? entry.Percent
    : (used !== null && total ? Math.round((used / total) * 1000) / 10 : null)
  // `ResetTime` is the RFC3339 form and `ResetTimestamp` the epoch form; the lanes
  // differ on which they populate, so prefer whichever is present.
  const resetAt = typeof entry.ResetTime === 'string' && entry.ResetTime.length > 0
    ? entry.ResetTime
    : (typeof entry.ResetTimestamp === 'number' && entry.ResetTimestamp > 0
      ? new Date(entry.ResetTimestamp).toISOString()
      : null)
  return { label, used, total, percent, resetAt }
}

/**
 * Turn one lane's raw response into the snapshot the client renders.
 *
 * Both Actions answer with an envelope whose `Result` carries the periods; the
 * Coding Plan lane instead answers with a `QuotaUsage` array. Absent periods are
 * omitted rather than reported as zero, because "no data for this window" and
 * "nothing used" are different facts and only one of them is reassuring.
 *
 * @param plan - the lane being read.
 * @param envelope - the decoded OpenTOP response.
 * @returns the owned, JSON-safe snapshot.
 */
function toSnapshot(plan, envelope) {
  const result = envelope?.Result ?? envelope?.Result?.Result
  const periods = []

  if (result !== null && typeof result === 'object') {
    const afp = [
      ['5h', result.AFPFiveHour],
      ['daily', result.AFPDaily],
      ['weekly', result.AFPWeekly],
      ['monthly', result.AFPMonthly],
    ]
    for (const [key, entry] of afp) {
      // The lane returns a `daily` window that its own UI does not surface; the
      // per-window story is told by 5h / weekly / monthly.
      if (key === 'daily') continue
      const built = period(key, entry)
      if (built !== undefined) periods.push(built)
    }
  }

  // Coding Plan: `Result.QuotaUsage[]`, each entry naming its own window.
  const quotaUsage = result?.QuotaUsage
  if (Array.isArray(quotaUsage)) {
    for (const entry of quotaUsage) {
      const raw = typeof entry?.Label === 'string' ? entry.Label : entry?.Period
      if (typeof raw !== 'string' || raw.length === 0) continue
      const built = period(raw, entry)
      if (built !== undefined) periods.push(built)
    }
  }

  const order = new Map(PERIOD_LABELS.map((p, index) => [p.key, index]))
  periods.sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99))

  const tier = typeof result?.Tier === 'string' && result.Tier.length > 0 ? result.Tier : null
  const updatedAt = typeof envelope?.UpdatedAt === 'number'
    ? new Date(envelope.UpdatedAt).toISOString()
    : null

  return { periods, tier, updatedAt }
}

/**
 * Produce the quota state for every lane, reusing a recent snapshot.
 *
 * @param ctx - the plugin's Cordis context.
 * @param cache - the process-lifetime snapshot cache, keyed by plan route.
 * @param force - bypass the cache, used by the panel's manual refresh.
 * @returns one entry per lane, each either `ok` or explaining why it is not.
 */
async function readQuotas(ctx, cache, force = false) {
  const results = []
  for (const plan of PLANS) {
    const cached = cache.get(plan.route)
    if (!force && cached !== undefined && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      results.push(cached.value)
      continue
    }

    const value = await readQuotaFor(ctx, plan)
    cache.set(plan.route, { value, fetchedAtMs: Date.now() })
    results.push(value)
  }
  return results
}

/**
 * Read one lane's quota, converting every failure mode into an explained state.
 *
 * @param ctx - the plugin's Cordis context.
 * @param plan - the lane to read.
 * @returns the lane's snapshot plus its status.
 */
async function readQuotaFor(ctx, plan) {
  const base = { plan: plan.label, route: plan.route }
  let identity
  try {
    identity = await readIdentity(plan)
  } catch (error) {
    return { ...base, status: 'error', reason: `读取 arkcli 身份失败：${String(error)}` }
  }
  if (identity === undefined) {
    return {
      ...base,
      status: 'no-identity',
      reason: '未找到 arkcli 身份。额度接口在控制面，需要 SSO/AK-SK 签名；'
        + '先运行 `arkcli auth login volc-sso` 登录一次。',
    }
  }
  if (identity.expiresAt !== undefined && identity.expiresAt <= Date.now()) {
    return {
      ...base,
      status: 'expired',
      reason: 'arkcli 的 SSO 凭证已过期。运行 `arkcli auth login volc-sso` 重新登录后即可查询额度。',
    }
  }

  try {
    const envelope = await callOpenTop(plan.action, identity)
    const snapshot = toSnapshot(plan, envelope)
    if (snapshot.periods.length === 0) {
      return {
        ...base,
        status: 'not-subscribed',
        reason: `该账号下的 ${plan.label} 没有生效订阅，或本周期暂无额度数据。`,
      }
    }
    return { ...base, status: 'ok', ...snapshot, fetchedAt: new Date().toISOString() }
  } catch (error) {
    const message = String(error)
    const detail = /InvalidCredential|Authentication|AccessDenied/i.test(message)
      ? '控制面拒绝了这份签名。通常是 arkcli 的登录态失效 —— 运行 `arkcli auth login volc-sso` 重新登录。'
      : message
    ctx.logger.warn(`${PREFIX} ${plan.label} quota unavailable — ${message}`)
    return { ...base, status: 'error', reason: detail }
  }
}

/**
 * Report each declared route's credential state.
 *
 * Reads only the reference's *presence* through the credential seam — never the
 * secret — because that seam is the single supported way to ask, and a plugin that
 * read `.credentials.yaml` itself would break the moment the storage provider changes.
 *
 * @param ctx - the plugin's Cordis context.
 */
async function reportStatus(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    ctx.logger.warn(
      `${PREFIX} the credentials service is absent from this composition, so the two Ark routes can only resolve their key from the launch environment`,
    )
    return
  }
  for (const plan of PLANS) {
    try {
      const info = await credentials.describe(plan.ref)
      if (info.configured === true) {
        ctx.logger.info(
          `${PREFIX} ${plan.label} ready — route "${plan.route}" resolves ${plan.ref}`,
        )
      } else {
        ctx.logger.warn(
          `${PREFIX} ${plan.label} declared but keyless — open ${UI_HINT} and paste the plan's API key; `
          + `it is stored as the reference ${plan.ref} and every ${plan.route} request fails with MISSING_CREDENTIAL until then`,
        )
      }
    } catch (error) {
      ctx.logger.error(`${PREFIX} could not describe ${plan.ref} (${String(error)})`)
    }
  }
}

/**
 * Answer one route request with a JSON body.
 *
 * `content-length` is set as a string because a header value is a string on the wire;
 * a bare number is coerced by Node today but is not what the contract says.
 *
 * @param res - the route's response.
 * @param status - the HTTP status to send.
 * @param body - the JSON-safe body.
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/**
 * Test whether a request arrived over the loopback interface.
 *
 * @param req - the route's request.
 * @returns true only for 127.0.0.1 / ::1, in any of the forms Node reports.
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Mount the status reporter and the quota route.
 *
 * Nothing here awaits before it registers its effects, and each asynchronous path
 * catches its own failure, so the plugin tree can never be held up or torn down by a
 * diagnostic — including when the credentials service arrives later than this row.
 *
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    void reportStatus(ctx).catch(() => {})
    return () => {}
  })

  // The route's key is resolved per request, so storing one in the Models page takes
  // effect on the next request with no restart; re-reporting here is what tells the
  // user that, instead of leaving them to guess whether the paste worked.
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.on('credentials/reference-updated', (ref) => {
      if (PLANS.some((plan) => plan.ref === ref)) void reportStatus(ctx).catch(() => {})
    })
  })

  // Snapshot cache lives with the fiber, so removing the plugin removes its state.
  const cache = new Map()
  ctx.effect(() => () => cache.clear())

  // The session header's quota pill (client half) reads this route over same-origin
  // `fetch`. That is the shape a packaged plugin uses to cross the two halves in this
  // harness: `webServer` is the host service that owns HTTP, and the browser half has
  // no Cordis wire of its own.
  //
  // The handler converts every control-plane failure into a 200 body that explains
  // itself, because "the quota could not be read, and here is why" is a state the pill
  // must be able to render — a 5xx would only reach it as an opaque fetch rejection.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: QUOTA_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        // The route is reachable from anything that can open a socket on the bound
        // interface, so it is fenced to loopback: the data is the operator's own
        // subscription state, and no browser on the network has business reading it.
        if (!isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'request-not-trusted' })
          return
        }
        try {
          const force = typeof req.url === 'string' && req.url.includes('force=1')
          const plans = await readQuotas(ctx, cache, force)
          writeJson(res, 200, { ok: true, plans, checkedAt: new Date().toISOString() })
        } catch (error) {
          ctx.logger.error(`${PREFIX} quota read failed — ${String(error)}`)
          writeJson(res, 200, { ok: false, error: String(error), plans: [] })
        }
      },
    }), `${PREFIX} quota route`)
  })
}
