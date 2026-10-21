alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.invoices enable row level security;

create policy "members read their organizations" on public.organizations
  for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = organizations.id and m.user_id = (select auth.uid())));

create policy "users read their memberships" on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "signed-in users read profiles" on public.profiles
  for select to authenticated
  using (true);

create policy "users update their own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()));

create policy "members read live projects" on public.projects
  for select to authenticated
  using (
    deleted_at is null
    and org_id in (select m.org_id from public.memberships m where m.user_id = (select auth.uid()))
  );

create policy "members create projects" on public.projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.is_org_member(org_id));

create policy "owners update projects" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "admins read invoices" on public.invoices
  for select to authenticated
  using ((auth.jwt() ->> 'user_role') = 'admin' and public.is_org_member(org_id));
