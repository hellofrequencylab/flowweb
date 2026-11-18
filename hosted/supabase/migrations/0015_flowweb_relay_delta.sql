-- FlowWeb hosted mirror, migration 0015 (row FW-C-161): the relay sends only what changed.
--
-- fw_relay_ingest (0006) takes the whole snapshot on every push and rewrites every row. A machine with a
-- few hundred rows sent megabytes a minute to say "nothing changed", and large pushes were refused.
-- fw_relay_ingest_delta takes the full list of keys the machine holds plus only the envelopes that
-- changed since its last accepted push:
--   * a row whose key is not in p_keys is deleted (same rule as before);
--   * an envelope in p_entries is stored;
--   * a row in p_keys with no envelope in this push keeps its envelope and only has synced_at moved
--     forward, which is how the site knows the row was confirmed current at this push;
--   * `missing` in the answer lists keys the machine believes are stored but are not, so the relay
--     sends those in full next time. A first push, or a wiped table, heals itself this way.
-- fw_relay_ingest stays as it is, so an older relay keeps working. Safe to run twice.

create or replace function public.fw_relay_ingest_delta(p_token text, p_keys text[], p_entries jsonb, p_report jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rid uuid;
  acc uuid;
  n int;
  gone jsonb;
begin
  select id, account_id into rid, acc from public.fw_runners
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and revoked_at is null;
  if rid is null then
    raise exception 'unknown runner token' using errcode = '28000';
  end if;
  if p_keys is null then
    raise exception 'keys must be the list of every key this machine holds' using errcode = '22023';
  end if;
  if jsonb_typeof(p_entries) <> 'object' then
    raise exception 'entries must be an object of key -> envelope' using errcode = '22023';
  end if;
  if pg_column_size(p_entries) > 20 * 1024 * 1024 then
    raise exception 'snapshot too large' using errcode = '54000';
  end if;

  delete from public.fw_mirror m
   where m.account_id = acc and not (m.key = any(p_keys));
  insert into public.fw_mirror (account_id, key, envelope, runner_id, synced_at)
  select acc, e.key, e.value, rid, now() from jsonb_each(p_entries) e
   where e.key = any(p_keys)
  on conflict (account_id, key) do update
    set envelope = excluded.envelope, runner_id = excluded.runner_id, synced_at = excluded.synced_at;
  get diagnostics n = row_count;
  update public.fw_mirror m
     set synced_at = now(), runner_id = rid
   where m.account_id = acc and m.key = any(p_keys) and not (p_entries ? m.key);

  select coalesce(jsonb_agg(k.key), '[]'::jsonb) into gone
    from unnest(p_keys) as k(key)
   where not exists (select 1 from public.fw_mirror m where m.account_id = acc and m.key = k.key);

  update public.fw_runners
     set last_seen_at = now(), report = coalesce(p_report, '{}'::jsonb)
   where id = rid;
  return jsonb_build_object('stored', n, 'missing', gone, 'synced_at', now());
end;
$$;

revoke all on function public.fw_relay_ingest_delta(text, text[], jsonb, jsonb) from public;
grant execute on function public.fw_relay_ingest_delta(text, text[], jsonb, jsonb) to anon, authenticated;
