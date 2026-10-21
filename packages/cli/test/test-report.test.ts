import { describe, expect, it } from 'vitest'
import { formatTestReport } from '../src/format/test-report.js'

describe('formatTestReport', () => {
  it('prints failures, skipped reasons, infrastructure and the summary, indenting multi-line text', () => {
    const out = formatTestReport({
      files: [
        {
          rule: 'R-001', store: 'postgres', generated: 'changed', skipped: ['list: needs query filters to test; read cases cover the condition'],
          cases: [
            { name: 'read: allowed', expect: 'allow', actual: 'allow', passed: true },
            { name: 'read: denied', expect: 'deny', actual: 'allow', passed: false, detail: 'expected deny, got allow: line one\nline two' },
          ],
        },
        { rule: 'R-002', store: 'postgres', cases: [], skipped: ['check expressions are tested statically only'] },
      ],
      infrastructure: [{ store: 'firestore', message: 'the Firebase emulator did not start: a\nb' }],
    }, 'human')
    expect(out).toBe([
      'R-001 postgres: 1 passed, 1 failed (regenerated: the rule changed)',
      '  ✗ read: denied: expected deny, got allow: line one',
      '    line two',
      '  - skipped: list: needs query filters to test; read cases cover the condition',
      'R-002 postgres: no cases',
      '  - skipped: check expressions are tested statically only',
      '',
      'Could not run:',
      '  firestore: the Firebase emulator did not start: a',
      '    b',
      '',
      '1 passed, 1 failed in 2 rules',
      '',
    ].join('\n'))
  })

  it('hints at --regenerate when an allow case is denied, and prints a note without a store', () => {
    const out = formatTestReport({
      files: [
        { rule: 'R-001', store: 'firestore', skipped: [], cases: [{ name: 'create: allowed', expect: 'allow', actual: 'deny', passed: false, detail: 'expected allow, got deny' }] },
        { rule: 'R-009', cases: [], skipped: ['not tested: no cases can be generated for access rules'] },
      ],
      infrastructure: [],
    }, 'human')
    expect(out).toBe([
      'R-001 firestore: 0 passed, 1 failed',
      '  ✗ create: allowed: expected allow, got deny',
      'R-009: no cases',
      '  - skipped: not tested: no cases can be generated for access rules',
      '',
      'allow cases are built from the facts when the file was generated; after changing policies run holdline test --regenerate',
      '',
      '0 passed, 1 failed in 2 rules',
      '',
    ].join('\n'))
  })

  it('gives no hint for other failures', () => {
    const out = formatTestReport({ files: [{ rule: 'R-001', store: 'postgres', skipped: [], cases: [{ name: 'deny', expect: 'deny', actual: 'allow', passed: false }] }], infrastructure: [] }, 'human')
    expect(out).not.toContain('--regenerate')
  })

  it('labels a file --regenerate rebuilt for changed facts', () => {
    const out = formatTestReport({ files: [{ rule: 'R-001', store: 'postgres', generated: 'refreshed', skipped: [], cases: [{ name: 'a', expect: 'allow', actual: 'allow', passed: true }] }], infrastructure: [] }, 'human')
    expect(out.split('\n')[0]).toBe('R-001 postgres: 1 passed (regenerated: --regenerate (the facts changed))')
  })

  it('prints only the summary when nothing ran', () => {
    expect(formatTestReport({ files: [], infrastructure: [] }, 'human')).toBe('0 passed, 0 failed in 0 rules\n')
  })

  it('prints json with a summary', () => {
    const json = JSON.parse(formatTestReport({ files: [{ rule: 'R-001', store: 'storage', cases: [{ name: 'a', expect: 'deny', actual: 'deny', passed: true }], skipped: [] }], infrastructure: [] }, 'json'))
    expect(json.summary).toEqual({ passed: 1, failed: 0, rules: 1 })
  })
})
