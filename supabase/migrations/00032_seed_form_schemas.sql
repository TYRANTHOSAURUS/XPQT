-- Seed 5 starter form schemas and link them to existing demo request types.
-- Note: asset and location are handled at the request-type level via
-- fulfillment_strategy (requires_asset, asset_type_filter, requires_location),
-- so these forms carry only non-asset/location fields.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';

  -- config_entities.id
  e_it_incident        uuid := '40000000-0000-0000-0000-000000000001';
  e_it_service_request uuid := '40000000-0000-0000-0000-000000000002';
  e_maintenance_wo     uuid := '40000000-0000-0000-0000-000000000003';
  e_access_request     uuid := '40000000-0000-0000-0000-000000000005';
  e_catering_order     uuid := '40000000-0000-0000-0000-000000000006';

  -- config_versions.id (one per entity)
  v_it_incident        uuid := '41000000-0000-0000-0000-000000000001';
  v_it_service_request uuid := '41000000-0000-0000-0000-000000000002';
  v_maintenance_wo     uuid := '41000000-0000-0000-0000-000000000003';
  v_access_request     uuid := '41000000-0000-0000-0000-000000000005';
  v_catering_order     uuid := '41000000-0000-0000-0000-000000000006';
begin
  -- Insert config_entities (active form_schemas)
  insert into public.config_entities (id, tenant_id, config_type, slug, display_name, status)
  values
    (e_it_incident,        t, 'form_schema', 'it_incident',         'IT Incident',            'active'),
    (e_it_service_request, t, 'form_schema', 'it_service_request',  'IT Service Request',     'active'),
    (e_maintenance_wo,     t, 'form_schema', 'maintenance_wo',      'Maintenance Work Order', 'active'),
    (e_access_request,     t, 'form_schema', 'access_request',      'Access Request',         'active'),
    (e_catering_order,     t, 'form_schema', 'catering_order',      'Catering Order',         'active')
  on conflict (id) do nothing;

  -- Insert config_versions with the definition JSON
  insert into public.config_versions (id, config_entity_id, tenant_id, version_number, status, definition, published_at)
  values
    (v_it_incident, e_it_incident, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_impact','label','Impact','type','dropdown','required',true,'options',jsonb_build_array('Low','Medium','High'),'bound_to','impact'),
        jsonb_build_object('id','f_urgency','label','Urgency','type','dropdown','required',true,'options',jsonb_build_array('Low','Medium','High'),'bound_to','urgency')
      )),
      now()),
    (v_it_service_request, e_it_service_request, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',false),
        jsonb_build_object('id','f_justification','label','Justification / Notes','type','textarea','required',true),
        jsonb_build_object('id','f_attachments','label','Attachments','type','file_upload','required',false)
      )),
      now()),
    (v_maintenance_wo, e_maintenance_wo, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',false),
        jsonb_build_object('id','f_attachments','label','Attachments','type','file_upload','required',false)
      )),
      now()),
    (v_access_request, e_access_request, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',true),
        jsonb_build_object('id','f_justification','label','Justification / Notes','type','textarea','required',true)
      )),
      now()),
    (v_catering_order, e_catering_order, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',true),
        jsonb_build_object('id','f_headcount','label','Headcount','type','number','required',true),
        jsonb_build_object('id','f_dietary','label','Dietary Notes','type','textarea','required',false)
      )),
      now())
  on conflict (id) do nothing;

  -- Point config_entities at their version
  update public.config_entities set current_published_version_id = v_it_incident        where id = e_it_incident        and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_it_service_request where id = e_it_service_request and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_maintenance_wo     where id = e_maintenance_wo     and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_access_request     where id = e_access_request     and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_catering_order     where id = e_catering_order     and current_published_version_id is null;

  -- Link existing demo request types to starter forms where names align
  update public.request_types set form_schema_id = e_it_incident
    where tenant_id = t and form_schema_id is null and domain = 'it' and lower(name) like '%incident%';
  update public.request_types set form_schema_id = e_it_service_request
    where tenant_id = t and form_schema_id is null and domain = 'it' and (
      lower(name) like '%software%' or lower(name) like '%license%' or lower(name) like '%vpn%' or lower(name) like '%password%' or lower(name) like '%access%card%' or lower(name) like '%laptop%' or lower(name) like '%monitor%' or lower(name) like '%peripheral%'
    );
  update public.request_types set form_schema_id = e_maintenance_wo
    where tenant_id = t and form_schema_id is null and domain = 'fm' and (lower(name) like '%aircon%' or lower(name) like '%plumbing%' or lower(name) like '%lighting%' or lower(name) like '%maint%');
end $$;
