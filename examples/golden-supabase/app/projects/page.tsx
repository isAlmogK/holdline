import { supabase } from '../../lib/supabase'

export default async function ProjectsPage() {
  const db = await supabase()
  const { data: projects } = await db.from('projects').select('id, name, status').order('name')
  return (
    <ul>
      {(projects ?? []).map(p => <li key={p.id}>{p.name} ({p.status})</li>)}
    </ul>
  )
}
