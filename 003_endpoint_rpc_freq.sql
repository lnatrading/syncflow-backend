-- ============================================================
--  Migration 003 — RPC: insert sync_freq_minutes on endpoints
--  Updates create_supplier_with_endpoints to pass through the
--  optional per-endpoint sync_freq_minutes column added in
--  migration 002. Existing endpoints (and the column being NULL)
--  continue to behave as before.
-- ============================================================

create or replace function public.create_supplier_with_endpoints(
  p_supplier  jsonb,
  p_endpoints jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_supplier_id integer;
  v_supplier    jsonb;
  ep            jsonb;
begin
  insert into public.suppliers (
    name, active, auth_type, auth_username, auth_password,
    auth_key, auth_header_name, auth_extra, sync_freq, notes
  )
  values (
    p_supplier->>'name',
    coalesce((p_supplier->>'active')::boolean, true),
    coalesce(p_supplier->>'auth_type', 'none'),
    p_supplier->>'auth_username',
    p_supplier->>'auth_password',
    p_supplier->>'auth_key',
    p_supplier->>'auth_header_name',
    p_supplier->'auth_extra',
    coalesce((p_supplier->>'sync_freq')::integer, 30),
    p_supplier->>'notes'
  )
  returning id into v_supplier_id;

  for ep in select * from jsonb_array_elements(p_endpoints)
  loop
    insert into public.supplier_endpoints (
      supplier_id, role, url_template, format,
      is_parameterised, param_source_field,
      sync_freq_minutes,             -- new (nullable)
      active, sort_order
    )
    values (
      v_supplier_id,
      ep->>'role',
      ep->>'url_template',
      coalesce(ep->>'format', 'json'),
      coalesce((ep->>'is_parameterised')::boolean, false),
      ep->>'param_source_field',
      nullif(ep->>'sync_freq_minutes','')::integer,   -- NULL when not provided
      coalesce((ep->>'active')::boolean, true),
      coalesce((ep->>'sort_order')::integer, 0)
    );
  end loop;

  select row_to_json(s)::jsonb into v_supplier
  from public.suppliers s where s.id = v_supplier_id;

  return v_supplier || jsonb_build_object('endpoint_count', jsonb_array_length(p_endpoints));
end;
$$;
