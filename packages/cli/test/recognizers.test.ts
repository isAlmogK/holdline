import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Analyzer } from '@holdline/core'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzers } from '../src/analyzers.js'
import { makeProject, runCli } from './helpers/project.js'

const facts = JSON.stringify({
  version: 1,
  policies: [{ id: 'firestore:/dogs/{d}#read', store: 'firestore', target: '/dogs/{d}', ops: ['read'], condition: { atom: { op: 'authenticated' } } }],
})
const proposals = JSON.stringify({
  vocabulary: [{ id: 'staff', text: 'Caller is staff', expr: { atom: { op: 'in', left: 'actor.role', right: { literal: ['admin'] } } }, recognize: [{ 'firestore-function': 'isStaff' }] }],
  rules: [{ text: 'Staff read dogs', type: 'data-access', target: { store: 'firestore', path: '/dogs/{dogId}' }, ops: ['read'], requires: { ref: 'staff' } }],
})

describe('scanning passes approved recognizers to analyzers', () => {
  const seen: unknown[] = []
  const spy: Analyzer = { name: 'spy', version: '1', detect: () => true, analyze: async ctx => { seen.push(ctx.recognizers); return {} } }
  afterEach(() => {
    analyzers.splice(analyzers.indexOf(spy), 1)
    seen.length = 0
  })

  it('from holdline.rules, in scan and in commands that scan', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    expect((await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })).code).toBe(0)
    expect((await runCli(['approve', '--all'], { cwd: root })).code).toBe(0)
    analyzers.push(spy)
    await runCli(['scan'], { cwd: root })
    await runCli(['check'], { cwd: root })
    const staff = [{ id: 'staff', recognize: [{ 'firestore-function': 'isStaff' }] }]
    expect(seen).toEqual([staff, staff])
  })

  it('none when the vocabulary entry was edited, holdline.rules is missing, or it is invalid', async () => {
    const root = await makeProject({ 'facts.json': facts, 'proposals.json': proposals })
    analyzers.push(spy)
    expect((await runCli(['scan'], { cwd: root })).code).toBe(0)
    await runCli(['propose', 'proposals.json', '--facts', 'facts.json'], { cwd: root })
    await runCli(['approve', '--all'], { cwd: root })
    const rules = join(root, 'holdline.rules')
    await writeFile(rules, (await readFile(rules, 'utf8')).replace('isStaff', 'isAdmin'))
    expect((await runCli(['scan'], { cwd: root })).code).toBe(0)
    await writeFile(rules, 'version: [')
    expect((await runCli(['scan'], { cwd: root })).code).toBe(0)
    expect(seen).toEqual([[], [], []])
  })
})
