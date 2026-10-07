import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { routeKey, type Route, type Answer, type Delivery, type PromptJob, type Thread, type SessionRecord } from '../core/types'

const id = () => randomBytes(16).toString('hex')
function messageId() { return `<email-sync-${id()}@opencode.local>` }
export class Store {
  readonly db: Database
  constructor(path: string, readonly recipients: string[]) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, route TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, enabled INTEGER, baseline TEXT, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS answers(key TEXT PRIMARY KEY, routeKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, routeKey TEXT NOT NULL, route TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL, messageId TEXT UNIQUE NOT NULL, refs TEXT, control INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY, raw TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS prompts(id TEXT PRIMARY KEY, routeKey TEXT NOT NULL, route TEXT NOT NULL, text TEXT NOT NULL, sender TEXT NOT NULL, messageId TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'queued', owner TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS prompts_route ON prompts(routeKey,status);
      CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status,nextAt);`)
    // A remote SMTP or prompt operation may have completed before the crash.
    this.db.exec("UPDATE deliveries SET status='uncertain' WHERE status='sending'; UPDATE prompts SET status='queued',owner=NULL WHERE status='leased'; UPDATE prompts SET status='reconcile', owner=NULL WHERE status='dispatching'")
  }
  close() { this.db.close() }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)() }
  registerSession(route: Route, project: string, title: string) {
    this.db.query('INSERT INTO sessions(key,route,project,title) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET project=excluded.project,title=excluded.title,deleted=0').run(routeKey(route), JSON.stringify(route), project, title)
  }
  policy(route: Route): boolean { const row = this.db.query('SELECT enabled FROM sessions WHERE key=?').get(routeKey(route)) as { enabled: number | null } | null; return row?.enabled !== 0 }
  setPolicy(route: Route, enabled: boolean) {
    this.transaction(() => {
      this.db.query("INSERT INTO sessions(key,route,project,title,enabled) VALUES(?,?,'','',?) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled").run(routeKey(route), JSON.stringify(route), Number(enabled))
      if (!enabled) {
        this.db.query("UPDATE deliveries SET status='canceled' WHERE routeKey=? AND control=0 AND status='queued'").run(routeKey(route))
        this.db.query("UPDATE prompts SET status='canceled',owner=NULL WHERE routeKey=? AND status IN ('queued','leased')").run(routeKey(route))
      }
    })
  }
  session(route: Route): SessionRecord | null {
    const row = this.db.query('SELECT * FROM sessions WHERE key=?').get(routeKey(route)) as any
    return row ? { route: JSON.parse(row.route), project: row.project, title: row.title, baseline: row.baseline ? JSON.parse(row.baseline) : null, deleted: !!row.deleted } : null
  }
  baseline(route: Route, turns: string[]) { this.db.query('UPDATE sessions SET baseline=? WHERE key=?').run(JSON.stringify(turns), routeKey(route)) }
  deleted(route: Route) {
    this.transaction(() => {
      this.db.query('UPDATE sessions SET deleted=1 WHERE key=?').run(routeKey(route))
      const jobs = this.db.query("SELECT * FROM prompts WHERE routeKey=? AND status NOT IN ('accepted','canceled','failed')").all(routeKey(route)) as any[]
      for (const job of jobs) this.failDeletedJob(job)
      this.db.query("UPDATE deliveries SET status='canceled' WHERE routeKey=? AND control=0 AND status='queued'").run(routeKey(route))
    })
  }
  private failDeletedJob(job: { id: string; route: string; sender: string }) {
    const route = JSON.parse(job.route) as Route
    const session = this.session(route)
    this.db.query("UPDATE prompts SET status='failed',owner=NULL WHERE id=?").run(job.id)
    this.addDelivery({ route, project: session?.project || '', title: session?.title || '', text: 'This OpenCode session was deleted; your reply was not submitted.' }, job.sender, true)
  }
  routesFor(scope: Omit<Route, 'sessionId'>): Route[] {
    return (this.db.query('SELECT route FROM sessions').all() as { route: string }[]).map(row => JSON.parse(row.route) as Route).filter(route => route.instanceId === scope.instanceId && route.projectId === scope.projectId && route.directory === scope.directory)
  }
  answer(answer: Answer) {
    this.transaction(() => {
      const key = `${routeKey(answer.route)}:${answer.turnId}`
      if (!this.db.query('INSERT OR IGNORE INTO answers(key,routeKey) VALUES(?,?)').run(key, routeKey(answer.route)).changes) return
      if (!this.policy(answer.route)) return
      for (const recipient of this.recipients) this.addDelivery(answer, recipient, false)
    })
  }
  addDelivery(answer: Omit<Answer, 'turnId'>, recipient: string, control: boolean, refs?: string) {
    if (!refs && !control) refs = (this.db.query("SELECT messageId FROM deliveries WHERE routeKey=? AND recipient=? AND status='sent' ORDER BY rowid DESC LIMIT 1").get(routeKey(answer.route), recipient) as { messageId: string } | null)?.messageId
    this.db.query('INSERT INTO deliveries(id,routeKey,route,recipient,text,project,title,messageId,refs,control) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(), routeKey(answer.route), JSON.stringify(answer.route), recipient, answer.text, answer.project, answer.title, messageId(), refs ?? null, Number(control))
  }
  deliveries(now = Date.now()): Delivery[] {
    return (this.db.query("SELECT * FROM deliveries WHERE status='queued' AND nextAt<=? ORDER BY rowid LIMIT 20").all(now) as any[]).map(row => ({ ...row, route: JSON.parse(row.route), control: !!row.control, references: row.refs || undefined }))
  }
  startDelivery(delivery: Delivery): boolean {
    if (!delivery.control && !this.policy(delivery.route)) {
      this.db.query("UPDATE deliveries SET status='canceled' WHERE id=? AND status='queued'").run(delivery.id)
      return false
    }
    return !!this.db.query("UPDATE deliveries SET status='sending' WHERE id=? AND status='queued'").run(delivery.id).changes
  }
  finishDelivery(delivery: Delivery, status: string, nextAt = 0) { this.db.query('UPDATE deliveries SET status=?,attempts=attempts+1,nextAt=? WHERE id=?').run(status, nextAt, delivery.id) }
  thread(refs: string[], sender?: string): Thread | null {
    // Prefer the closest known reference. Multiple recipient copies of one route are not ambiguous.
    let found: Thread | null = null
    for (const ref of refs) {
      const row = this.db.query("SELECT * FROM deliveries WHERE messageId=? AND status IN ('sent','uncertain','sending')").get(ref) as any
      if (!row || (sender && row.recipient !== sender)) continue
      const thread = { route: JSON.parse(row.route), recipient: row.recipient, project: row.project, title: row.title, messageId: row.messageId }
      if (found && routeKey(found.route) !== routeKey(thread.route)) return null
      found ??= thread
    }
    return found
  }
  ingest(key: string, raw: string): boolean { return !!this.db.query('INSERT OR IGNORE INTO inbound(id,raw) VALUES(?,?)').run(key, raw).changes }
  pendingMail(): { id: string; raw: string }[] { return this.db.query("SELECT id,raw FROM inbound WHERE status='pending' ORDER BY rowid LIMIT 20").all() as any }
  processedMail(key: string) { this.db.query("UPDATE inbound SET status='processed',raw='' WHERE id=?").run(key) }
  enqueue(route: Route, key: string, text: string, sender: string) {
    this.db.query('INSERT OR IGNORE INTO prompts(id,routeKey,route,text,sender,messageId,created) VALUES(?,?,?,?,?,?,?)').run(key, routeKey(route), JSON.stringify(route), text, sender, `msg_${Date.now().toString(16).padStart(12, '0')}${id().slice(0, 16)}`, Date.now())
  }
  claim(route: Route, owner: string): PromptJob | null {
    return this.transaction(() => {
      const row = this.db.query("SELECT * FROM prompts WHERE routeKey=? AND status NOT IN ('accepted','canceled','failed') ORDER BY created,rowid LIMIT 1").get(routeKey(route)) as any
      if (row && !['queued', 'reconcile'].includes(row.status)) return null
      if (!row || (row.status === 'queued' && !this.policy(route))) return null
      if (!this.db.query("UPDATE prompts SET status='leased',owner=? WHERE id=? AND status IN ('queued','reconcile')").run(owner, row.id).changes) return null
      return { ...row, route: JSON.parse(row.route), owner }
    })
  }
  beginDispatch(key: string, owner: string): boolean {
    return this.transaction(() => {
      const row = this.db.query("SELECT route FROM prompts WHERE id=? AND owner=? AND status='leased'").get(key, owner) as { route: string } | null
      if (!row) return false
      const route = JSON.parse(row.route) as Route
      if (!this.policy(route) || this.session(route)?.deleted) return false
      return !!this.db.query("UPDATE prompts SET status='dispatching' WHERE id=? AND owner=? AND status='leased'").run(key, owner).changes
    })
  }
  ack(key: string, owner: string, status: 'accepted' | 'queued' | 'uncertain' | 'failed' | 'canceled') {
    this.transaction(() => {
      const job = this.db.query("SELECT * FROM prompts WHERE id=? AND owner=? AND status IN ('leased','dispatching')").get(key, owner) as any
      if (!job) return
      if (status === 'failed') this.failDeletedJob(job)
      else this.db.query('UPDATE prompts SET status=?,owner=NULL WHERE id=?').run(status, key)
    })
  }
  disconnect(owner: string) {
    this.db.query("UPDATE prompts SET status='queued',owner=NULL WHERE owner=? AND status='leased'").run(owner)
    this.db.query("UPDATE prompts SET status='reconcile',owner=NULL WHERE owner=? AND status='dispatching'").run(owner)
  }
  meta(key: string): string | null { return (this.db.query('SELECT value FROM metadata WHERE key=?').get(key) as any)?.value ?? null }
  setMeta(key: string, value: string) { this.db.query('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  resolve(key: string, action: 'retry' | 'cancel') {
    this.db.query("UPDATE deliveries SET status=?,nextAt=0 WHERE id=? AND status='uncertain'").run(action === 'retry' ? 'queued' : 'canceled', key)
    this.db.query("UPDATE prompts SET status=? WHERE id=? AND status='uncertain'").run(action === 'retry' ? 'reconcile' : 'canceled', key)
  }
  status() { return { deliveries: this.db.query('SELECT status,count(*) AS count FROM deliveries GROUP BY status').all(), prompts: this.db.query('SELECT status,count(*) AS count FROM prompts GROUP BY status').all(), uncertain: this.db.query("SELECT id,'delivery' AS kind FROM deliveries WHERE status='uncertain' UNION ALL SELECT id,'prompt' AS kind FROM prompts WHERE status='uncertain'").all() } }
}
