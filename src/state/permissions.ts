import { randomUUID } from 'node:crypto'
import type { Store } from './database'
import { routeKey, type PermissionRequest, type PermissionJob, type Route } from '../core/types'
import type { PermissionAction } from '../core/commands'
import { permissionText } from '../mail/permission'

const stale = 'This permission request was already answered or expired; no new permission was granted.'
export interface DecisionResult { ok: boolean; message: string; id?: string }
export type PermissionOutcome = 'accepted' | 'stale' | 'queued' | 'uncertain' | 'canceled'
export class PermissionStore {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS permissions(key TEXT PRIMARY KEY,routeKey TEXT NOT NULL,route TEXT NOT NULL,requestId TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',notified INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS permission_jobs(id TEXT PRIMARY KEY,key TEXT NOT NULL,action TEXT NOT NULL,sender TEXT,replyId TEXT,status TEXT NOT NULL DEFAULT 'queued',owner TEXT,created INTEGER NOT NULL,recovery INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS permission_jobs_status ON permission_jobs(key,status);`)
    if (!(store.db.query('PRAGMA table_info(deliveries)').all() as { name: string }[]).some(column => column.name === 'permissionKey')) store.db.exec('ALTER TABLE deliveries ADD COLUMN permissionKey TEXT')
    if (!(store.db.query('PRAGMA table_info(permission_jobs)').all() as { name: string }[]).some(column => column.name === 'recovery')) store.db.exec('ALTER TABLE permission_jobs ADD COLUMN recovery INTEGER NOT NULL DEFAULT 0')
    store.db.exec("UPDATE permission_jobs SET status=CASE WHEN recovery=1 THEN 'reconcile' ELSE 'queued' END,owner=NULL WHERE status='leased'; UPDATE permission_jobs SET status='reconcile',owner=NULL,recovery=1 WHERE status='dispatching'")
  }
  request(key: string): PermissionRequest | null { const row = this.row(key); return row ? JSON.parse(row.request) : null }
  shellRoute(route: Route, requestId?: string): Route {
    if (!requestId) return route
    const rows = this.store.db.query('SELECT route FROM permissions WHERE requestId=?').all(requestId) as { route: string }[]
    const matches = rows.map(row => JSON.parse(row.route) as Route).filter(target => target.instanceId === route.instanceId && target.projectId === route.projectId && target.directory === route.directory)
    return matches.length === 1 ? matches[0] : route
  }
  private row(key: string): any { return this.store.db.query('SELECT * FROM permissions WHERE key=?').get(key) }
  sync(route: Route, requests: PermissionRequest[], source = '', activeSources?: Set<string>) {
    const store = this.store
    store.transaction(() => {
      const previous = store.db.query("SELECT * FROM permissions WHERE routeKey=? AND status='pending'").all(routeKey(route)) as any[]
      for (const row of previous) {
        if (row.source !== source && activeSources?.has(row.source)) continue
        if (!requests.some(request => request.id === row.requestId)) {
          store.db.query("UPDATE permissions SET status='closed' WHERE key=?").run(row.key)
          store.db.query("UPDATE deliveries SET status='canceled' WHERE permissionKey=? AND control=0 AND status='queued'").run(row.key)
          for (const job of store.db.query("SELECT id FROM permission_jobs WHERE key=? AND status IN ('queued','leased','reconcile')").all(row.key) as { id: string }[]) this.finish(job.id, 'stale')
        }
      }
      for (const request of requests) {
        const key = JSON.stringify([routeKey(route), request.id])
        store.db.query('INSERT INTO permissions(key,routeKey,route,requestId,request,source) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET request=excluded.request,source=excluded.source').run(key, routeKey(route), JSON.stringify(route), request.id, JSON.stringify(request), source)
        const row = this.row(key)
        if (row.status !== 'pending' || row.notified || !store.policy(route) || store.session(route)?.deleted) continue
        const session = store.session(route)
        for (const recipient of store.recipients) store.addDelivery({ route, project: session?.project || '', title: session?.title || '', text: permissionText(request) }, recipient, false, undefined, key)
        store.db.query('UPDATE permissions SET notified=1 WHERE key=?').run(key)
      }
    })
  }
  decide(route: Route, action: PermissionAction, options: { key?: string; requestId?: string; sender?: string; replyId?: string } = {}): DecisionResult {
    return this.store.transaction(() => {
      if (!this.store.policy(route)) return { ok: false, message: 'Email sync is OFF; enable it before answering permissions by email or CLI.' }
      if (this.store.session(route)?.deleted) return { ok: false, message: stale }
      let row
      if (options.key) row = this.row(options.key)
      else if (options.requestId) row = this.store.db.query('SELECT * FROM permissions WHERE routeKey=? AND requestId=?').get(routeKey(route), options.requestId)
      else {
        const rows = this.store.db.query("SELECT * FROM permissions WHERE routeKey=? AND status='pending'").all(routeKey(route))
        if (rows.length > 1) return { ok: false, message: 'Multiple permissions are pending; append the request ID shown in the permission email.' }
        row = rows[0]
      }
      if (!row || row.routeKey !== routeKey(route) || row.status !== 'pending') return { ok: false, message: stale }
      if (options.requestId && row.requestId !== options.requestId) return { ok: false, message: 'The request ID does not match the permission email thread.' }
      if (this.store.db.query("SELECT id FROM permission_jobs WHERE key=? AND status IN ('queued','leased','dispatching','reconcile','uncertain')").get(row.key)) return { ok: false, message: 'A decision for this permission is already pending; no second decision was submitted.' }
      const id = randomUUID()
      this.store.db.query('INSERT INTO permission_jobs(id,key,action,sender,replyId,created) VALUES(?,?,?,?,?,?)').run(id, row.key, action, options.sender ?? null, options.replyId ?? null, Date.now())
      return { ok: true, id, message: `Permission decision ${action} queued for ${row.requestId}; awaiting OpenCode confirmation.` }
    })
  }
  claim(route: Route, owner: string): PermissionJob | null {
    return this.store.transaction(() => {
      if (!this.store.policy(route)) return null
      const row = this.store.db.query("SELECT j.*,p.route,p.requestId,p.request,p.source FROM permission_jobs j JOIN permissions p ON p.key=j.key WHERE p.routeKey=? AND p.status='pending' AND j.status IN ('queued','reconcile') AND (p.source='' OR p.source=?) ORDER BY j.created,j.rowid LIMIT 1").get(routeKey(route), owner) as any
      if (!row) return null
      if (!this.store.db.query("UPDATE permission_jobs SET status='leased',owner=?,recovery=CASE WHEN status='reconcile' THEN 1 ELSE recovery END WHERE id=? AND status IN ('queued','reconcile')").run(owner, row.id).changes) return null
      return { kind: 'permission', id: row.id, key: row.key, route: JSON.parse(row.route), requestId: row.requestId, targetSessionId: JSON.parse(row.request).sessionID, action: row.action, owner, status: row.status }
    })
  }
  begin(id: string, owner: string): boolean {
    return this.store.transaction(() => {
      const row = this.store.db.query("SELECT j.id,p.route,p.status FROM permission_jobs j JOIN permissions p ON p.key=j.key WHERE j.id=? AND j.owner=? AND j.status='leased'").get(id, owner) as any
      if (!row || row.status !== 'pending') return false
      const route = JSON.parse(row.route)
      if (!this.store.policy(route) || this.store.session(route)?.deleted) return false
      return !!this.store.db.query("UPDATE permission_jobs SET status='dispatching',recovery=1 WHERE id=? AND owner=? AND status='leased'").run(id, owner).changes
    })
  }
  ack(id: string, owner: string, outcome: PermissionOutcome) {
    this.store.transaction(() => {
      const job = this.store.db.query("SELECT * FROM permission_jobs WHERE id=? AND owner=? AND status IN ('leased','dispatching')").get(id, owner) as any
      if (!job) return
      if (outcome === 'queued') this.store.db.query("UPDATE permission_jobs SET status='queued',owner=NULL WHERE id=?").run(id)
      else this.finish(id, outcome)
    })
  }
  private finish(id: string, outcome: Exclude<PermissionOutcome, 'queued'>) {
    const job = this.store.db.query('SELECT * FROM permission_jobs WHERE id=?').get(id) as any
    if (!job || ['accepted', 'stale', 'canceled'].includes(job.status)) return
    this.store.db.query('UPDATE permission_jobs SET status=?,owner=NULL WHERE id=?').run(outcome, id)
    const row = this.row(job.key)
    if (outcome === 'accepted' || outcome === 'stale') this.store.db.query("UPDATE permissions SET status='closed' WHERE key=?").run(job.key)
    if (!job.sender || !this.store.recipients.includes(job.sender) || job.status === 'uncertain') return
    const route = JSON.parse(row.route)
    const session = this.store.session(route)
    const message = outcome === 'accepted' ? `Permission ${row.requestId} ${job.action === 'once' ? 'approved once' : job.action === 'reject' ? 'rejected' : 'approved for matching actions using OpenCode always'}; OpenCode accepted the decision.` : outcome === 'stale' ? stale : outcome === 'canceled' ? 'Permission decision canceled because email sync was disabled; no permission was granted.' : 'Could not confirm this permission decision. It will not be blindly replayed; check the OpenCode permission UI.'
    this.store.addDelivery({ route, project: session?.project || '', title: session?.title || '', text: message }, job.sender, true, job.replyId || undefined, job.key)
  }
  cancel(route: Route, staleRequest = false) {
    const jobs = this.store.db.query("SELECT j.id FROM permission_jobs j JOIN permissions p ON p.key=j.key WHERE p.routeKey=? AND j.status IN ('queued','leased','reconcile')").all(routeKey(route)) as { id: string }[]
    for (const job of jobs) this.finish(job.id, staleRequest ? 'stale' : 'canceled')
    if (staleRequest) this.store.db.query("UPDATE permissions SET status='closed' WHERE routeKey=?").run(routeKey(route))
  }
  disconnect(owner: string) {
    this.store.db.query("UPDATE permission_jobs SET status=CASE WHEN recovery=1 THEN 'reconcile' ELSE 'queued' END,owner=NULL WHERE owner=? AND status='leased'").run(owner)
    this.store.db.query("UPDATE permission_jobs SET status='reconcile',owner=NULL,recovery=1 WHERE owner=? AND status='dispatching'").run(owner)
  }
  resolve(id: string, action: 'retry' | 'cancel') {
    if (action === 'retry') this.store.db.query("UPDATE permission_jobs SET status='reconcile',recovery=1 WHERE id=? AND status='uncertain'").run(id)
    else this.store.db.query("UPDATE permission_jobs SET status='canceled',owner=NULL WHERE id=? AND status='uncertain'").run(id)
  }
  status(id: string): { status: string } | null { return this.store.db.query('SELECT status FROM permission_jobs WHERE id=?').get(id) as { status: string } | null }
}
