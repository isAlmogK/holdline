import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Every query runs as the signed-in user, so row level security decides what it sees.
export async function supabase() {
  const store = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: () => {} },
  })
}
