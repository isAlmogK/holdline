import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuleSchema, hashRule, serializeRulesFile, type RulesFile } from '@holdline/core'
import { describe, expect, it } from 'vitest'
import { makeProject, runCli } from './helpers/project.js'

const auth = { atom: { op: 'authenticated' } }
const admin = { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } }

function rulesFile(requires: unknown, routes = 'POST /dogs/*/transfer'): string {
  const rule = RuleSchema.parse({ id: 'R-001', text: 'Only admins transfer dogs', type: 'access', target: { routes }, requires, evidence: ['h:transfer'], status: 'approved' })
  const file: RulesFile = { version: 1, vocabulary: [], rules: [{ ...rule, approved: { by: 't', at: '2026-10-21', hash: hashRule(rule, new Map()) } }] }
  return serializeRulesFile(file)
}

const facts = JSON.stringify({
  version: 1,
  symbols: [{ id: 'h:transfer', kind: 'function', lang: 'ts', location: { file: 'src/dogs.ts', line: 40 } }],
  routes: [{ id: 'route:POST /dogs/:id/transfer', method: 'POST', path: '/dogs/:id/transfer', handler: 'h:transfer', framework: 'express' }],
  guards: [{ at: 'h:transfer', requires: auth }],
})

describe('holdline check', () => {
  it('exits 0 when every rule passes', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(auth), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('✓ 1 rule passes')
  })
  it('exits 1 and explains the violation in human format', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('✗ R-001 Only admins transfer dogs')
    expect(out.stdout).toContain('POST /dogs/:id/transfer does not check actor.role in ["admin"]')
    expect(out.stdout).toContain('src/dogs.ts:40')
  })
  it('prints agent feedback', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'agent'], { cwd: root })
    expect(out.stdout).toContain('Holdline: 1 approved rule is broken.')
    expect(out.stdout).toContain('Do not edit holdline.rules')
    expect(out.stdout).toContain('R-001 "Only admins transfer dogs" at src/dogs.ts:40')
    expect(out.stdout).toContain('Missing: actor.role in ["admin"]')
    expect(out.stdout).toContain('Fix:')
    expect(out.stdout).toContain('stop and ask the user')
  })
  it('tells the agent to undo an unapproved edit, never to approve it', async () => {
    const edited = rulesFile(auth).replace('Only admins transfer dogs', 'Anyone transfers dogs')
    const root = await makeProject({ 'holdline.rules': edited, 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'agent'], { cwd: root })
    expect(out.code).toBe(1)
    expect(out.stdout).toContain('Undo your change')
    expect(out.stdout).not.toContain('Approve it with')
    expect(out.stdout).not.toContain('..')
  })
  it('exits 2 on usage errors and 3 on internal errors', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(auth), 'facts.json': facts })
    expect((await runCli(['check', '--facts', 'facts.json', '--format', 'bogus'], { cwd: root })).code).toBe(2)
    expect((await runCli(['check', '--facts', 'missing.json'], { cwd: root })).code).toBe(2)
    expect((await runCli(['explain', 'R-404', '--facts', 'facts.json'], { cwd: root })).code).toBe(2)
    expect((await runCli(['mute', 'R-404', '--reason', 'x'], { cwd: root })).code).toBe(2)
    const dir = await makeProject({ 'holdline.rules/keep': '' })
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: dir })).code).toBe(3)
  })
  it('prints JSON', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json', '--format', 'json'], { cwd: root })
    const parsed = JSON.parse(out.stdout)
    expect(parsed.summary.violation).toBe(1)
    expect(parsed.results[0].rule).toBe('R-001')
  })
  it('treats stale as failure only with --strict', async () => {
    const stale = rulesFile(auth, 'POST /cats/*/transfer')
    const root = await makeProject({ 'holdline.rules': stale, 'facts.json': facts })
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: root })).code).toBe(0)
    expect((await runCli(['check', '--facts', 'facts.json', '--strict'], { cwd: root })).code).toBe(1)
  })
  it('exits 2 on a malformed rules file and 2 on bad facts', async () => {
    const bad = await makeProject({ 'holdline.rules': 'rules: [', 'facts.json': facts })
    const out = await runCli(['check', '--facts', 'facts.json'], { cwd: bad })
    expect(out.code).toBe(2)
    expect(out.stderr).toContain('invalid YAML')
    const badFacts = await makeProject({ 'holdline.rules': rulesFile(auth), 'facts.json': '{"version":9}' })
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: badFacts })).code).toBe(2)
  })
  it('exits 2 on an unknown command', async () => {
    const root = await makeProject({})
    expect((await runCli(['frobnicate'], { cwd: root })).code).toBe(2)
  })
})

describe('holdline explain and mute', () => {
  it('explains a rule with its status and evidence', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    const out = await runCli(['explain', 'R-001', '--facts', 'facts.json'], { cwd: root })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('R-001 Only admins transfer dogs')
    expect(out.stdout).toContain('approved by t on 2026-10-21')
    expect(out.stdout).toContain('evidence: h:transfer (src/dogs.ts:40)')
    expect(out.stdout).toContain('violation')
  })
  it('mutes a rule with a reason', async () => {
    const root = await makeProject({ 'holdline.rules': rulesFile(admin), 'facts.json': facts })
    expect((await runCli(['mute', 'R-001'], { cwd: root })).code).toBe(2)
    const out = await runCli(['mute', 'R-001', '--reason', 'migrating auth'], { cwd: root })
    expect(out.code).toBe(0)
    const saved = await readFile(join(root, 'holdline.rules'), 'utf8')
    expect(saved).toContain('reason: migrating auth')
    expect(saved).toContain('by: tester')
    expect((await runCli(['check', '--facts', 'facts.json'], { cwd: root })).code).toBe(0)
    const ex = await runCli(['explain', 'R-001', '--facts', 'facts.json'], { cwd: root })
    expect(ex.stdout).toContain('muted, not enforced')
  })
})
