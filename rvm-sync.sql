begin;

create table if not exists public.rvm_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  revision integer not null check (revision > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object')
);

alter table public.rvm_progress enable row level security;
revoke all on public.rvm_progress from public, anon, authenticated;
grant select on public.rvm_progress to authenticated;

drop policy if exists rvm_read_own_progress on public.rvm_progress;
create policy rvm_read_own_progress on public.rvm_progress
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.rvm_save_progress(expected_revision integer, new_snapshot jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  saved_revision integer;
begin
  if account_id is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if expected_revision is null or expected_revision < 0
    or new_snapshot is null or jsonb_typeof(new_snapshot) <> 'object' then
    raise exception 'Invalid progress' using errcode = '22023';
  end if;

  if expected_revision = 0 then
    insert into public.rvm_progress as progress (user_id, revision, snapshot)
    values (account_id, 1, new_snapshot)
    on conflict (user_id) do nothing
    returning progress.revision into saved_revision;
  else
    update public.rvm_progress as progress
    set revision = progress.revision + 1, snapshot = new_snapshot
    where progress.user_id = account_id and progress.revision = expected_revision
    returning progress.revision into saved_revision;
  end if;

  return saved_revision;
end;
$$;

revoke all on function public.rvm_save_progress(integer, jsonb) from public, anon, authenticated;
grant execute on function public.rvm_save_progress(integer, jsonb) to authenticated;

commit;
