import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/state/database'
import { routeKey } from '../../src/core/types'
test('v0.2 database upgrades preserve policies, threads, baselines and ordinary jobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-v02-migration-')); const path = join(directory, 'state.sqlite')
  const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
  try {
    const old = new Database(path)
    // These are the actual v0.2 table shapes, before permissionKey and the
    // permission tables existed. Seed records without using the new Store.
    old.exec(`CREATE TABLE sessions(key TEXT PRIMARY KEY,route TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,enabled INTEGER,baseline TEXT,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE deliveries(id TEXT PRIMARY KEY,routeKey TEXT NOT NULL,route TEXT NOT NULL,recipient TEXT NOT NULL,text TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,messageId TEXT UNIQUE NOT NULL,refs TEXT,control INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE prompts(id TEXT PRIMARY KEY,routeKey TEXT NOT NULL,route TEXT NOT NULL,text TEXT NOT NULL,sender TEXT NOT NULL,messageId TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'queued',owner TEXT,created INTEGER NOT NULL);`)
    old.query('INSERT INTO sessions VALUES(?,?,?,?,?,?,0)').run(routeKey(route), JSON.stringify(route), 'Project', 'Session', 0, '["old-turn"]')
    old.query("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,NULL,0,'sent',1,0)").run('old-delivery', routeKey(route), JSON.stringify(route), 'me@example.com', 'Old answer', 'Project', 'Session', '<old@local>')
    old.query("INSERT INTO prompts VALUES(?,?,?,?,?,?,'accepted',NULL,1)").run('old-reply', routeKey(route), JSON.stringify(route), 'Old instruction', 'me@example.com', 'msg_old')
    old.close()
    const store = new Store(path, ['me@example.com'])
    expect(store.policy(route)).toBe(false)
    expect(store.session(route)?.baseline).toEqual(['old-turn'])
    expect(store.thread(['<old@local>'])?.route).toEqual(route)
    expect(store.thread(['<old@local>'])?.permissionKey).toBeUndefined()
    expect(store.claim(route, 'adapter')).toBeNull()
    store.setPolicy(route, true)
    store.permissions.sync(route, [{ id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['printf'], always: ['printf'], metadata: {} }])
    expect(store.deliveries()).toHaveLength(1)
    expect(store.permissions.decide(route, 'reject', { requestId: 'per_a' }).ok).toBe(true)
    expect(store.permissions.claim(route, 'adapter')?.action).toBe('reject')
    store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
