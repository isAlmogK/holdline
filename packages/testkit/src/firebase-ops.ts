// Seeds and operations for one Firestore or Storage case (spec 5.3), and how their outcome is read.
import type { RulesTestContext } from '@firebase/rules-unit-testing'
import type { TestCase, TestFile } from '@holdline/core'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, type Firestore } from 'firebase/firestore'
import { deleteObject, getMetadata, listAll, ref, uploadString, type FirebaseStorage } from 'firebase/storage'

type Data = Record<string, unknown>

// The contexts hand out compat instances; the modular functions unwrap them at runtime.
const firestore = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore
const storage = (ctx: RulesTestContext) => ctx.storage() as unknown as FirebaseStorage

// Storage objects carry seed and request data as custom metadata, which holds strings only.
export function toMetadata(data: Data): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  }
  return out
}

const upload = (ctx: RulesTestContext, path: string, data: Data) =>
  uploadString(ref(storage(ctx), path), '', 'raw', { customMetadata: toMetadata(data) })

// Runs inside `withSecurityRulesDisabled`: storage-file objects are uploaded, every other seed is a document.
export async function seed(ctx: RulesTestContext, seeds: TestCase['seed']): Promise<void> {
  for (const s of seeds) {
    if (s.store === 'storage') await upload(ctx, s.path, s.data)
    else await setDoc(doc(firestore(ctx), s.path), s.data)
  }
}

async function firestoreOp(ctx: RulesTestContext, op: TestCase['do']): Promise<unknown> {
  const db = firestore(ctx)
  switch (op.op) {
    case 'read': return getDoc(doc(db, op.path))
    case 'list': return getDocs(collection(db, op.path))
    case 'create': return setDoc(doc(db, op.path), op.data ?? {})
    case 'update': return updateDoc(doc(db, op.path), op.data ?? {})
    case 'delete': return deleteDoc(doc(db, op.path))
  }
}

async function storageOp(ctx: RulesTestContext, op: TestCase['do']): Promise<unknown> {
  const object = ref(storage(ctx), op.path)
  switch (op.op) {
    case 'read': return getMetadata(object)
    case 'list': return listAll(object)
    case 'create':
    case 'update': return upload(ctx, op.path, op.data ?? {})
    case 'delete': return deleteObject(object)
  }
}

export function operate(ctx: RulesTestContext, store: TestFile['store'], op: TestCase['do']): Promise<unknown> {
  if (store === 'firestore') return firestoreOp(ctx, op)
  if (store === 'storage') return storageOp(ctx, op)
  return Promise.reject(new Error(`a ${store} test file cannot run on the Firebase emulator`))
}

export type Run = { actual: 'allow' | 'deny' | 'error'; error?: string }

const DENIED = new Set(['permission-denied', 'storage/unauthorized'])

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function attempt(run: () => Promise<unknown>): Promise<Run> {
  try {
    await run()
    return { actual: 'allow' }
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    return { actual: typeof code === 'string' && DENIED.has(code) ? 'deny' : 'error', error: describeError(e) }
  }
}
