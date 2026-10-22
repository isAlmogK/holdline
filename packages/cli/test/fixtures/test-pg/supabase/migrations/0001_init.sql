create table public.orgs (id uuid primary key, name text not null);

create table public.memberships (
  org_id uuid not null references public.orgs(id),
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  primary key (org_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id), owner_id uuid not null,
  title text not null,
  amount int not null check (amount > 0),
  unique (org_id, title)
);

-- The Supabase profile shape: the primary key references auth.users, and the username is unique.
create table public.profiles (
  id uuid primary key references auth.users(id),
  username text not null unique
);

alter table public.projects enable row level security;

create policy read_members on public.projects for select using (
  exists (select 1 from public.memberships m where m.org_id = projects.org_id and m.user_id = auth.uid()));
create policy update_owner on public.projects for update using (owner_id = auth.uid());
create policy insert_owner on public.projects for insert with check (owner_id = auth.uid());
create policy delete_owner on public.projects for delete using (owner_id = auth.uid());
