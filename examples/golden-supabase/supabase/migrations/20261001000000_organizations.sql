-- Organizations and who belongs to them.
create type public.membership_role as enum ('owner', 'admin', 'member');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null default 'member',
  constraint memberships_org_user_key unique (org_id, user_id)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text
);

-- Membership check used by policies. Security definer so it can read memberships under RLS.
create function public.is_org_member(target_org uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$ select exists (select 1 from public.memberships m where m.org_id = target_org and m.user_id = (select auth.uid())) $$;
