import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'test123';
const TOTAL_CORPORATE_PEOPLE = 500;
const GENERATED_CASE_COUNT = 210;

const ROLE_IDS = {
  admin: '91000000-0000-0000-0000-000000000001',
  agent: '91000000-0000-0000-0000-000000000002',
  employee: '91000000-0000-0000-0000-000000000003',
};

const TEAM_IDS = {
  serviceDesk: '94000000-0000-0000-0000-000000000001',
  it: '94000000-0000-0000-0000-000000000002',
  hr: '94000000-0000-0000-0000-000000000003',
  facilitiesAmsterdam: '94000000-0000-0000-0000-000000000004',
  facilitiesDenHaag: '94000000-0000-0000-0000-000000000005',
  facilitiesDenBosch: '94000000-0000-0000-0000-000000000006',
};

const SPACE_IDS = {
  amsSite: '93000000-0000-0000-0000-000000000001',
  amsA: '93000000-0000-0000-0000-000000000011',
  amsB: '93000000-0000-0000-0000-000000000012',
  amsC: '93000000-0000-0000-0000-000000000013',
  dhgA: '93000000-0000-0000-0000-000000000021',
  dhgB: '93000000-0000-0000-0000-000000000022',
  dbhA: '93000000-0000-0000-0000-000000000031',
};

const FIXED_LOGIN_EMAILS = [
  'dev@prequest.nl',
  'servicedesk.admin@prequest.nl',
  'servicedesk.agent@prequest.nl',
  'it.admin@prequest.nl',
  'it.agent@prequest.nl',
  'hr.agent@prequest.nl',
  'facilities.amsterdam@prequest.nl',
  'cleaning.vendor@prequest.nl',
  'manager.approver@prequest.nl',
  'employee.requester@prequest.nl',
];

const FIXED_CORPORATE_EMAILS = new Set([
  'dev@prequest.nl',
  'servicedesk.admin@prequest.nl',
  'servicedesk.agent@prequest.nl',
  'it.admin@prequest.nl',
  'it.agent@prequest.nl',
  'hr.agent@prequest.nl',
  'facilities.amsterdam@prequest.nl',
  'manager.approver@prequest.nl',
  'employee.requester@prequest.nl',
]);

const FIRST_NAMES = [
  'Eva', 'Lotte', 'Sophie', 'Emma', 'Mila', 'Noa', 'Julia', 'Saar', 'Nina', 'Iris',
  'Sanne', 'Roos', 'Anna', 'Lauren', 'Amy', 'Olivia', 'Grace', 'Ella', 'Isla', 'Megan',
  'Liam', 'Noah', 'Daan', 'Levi', 'Lucas', 'Sem', 'Milan', 'Finn', 'James', 'Oliver',
  'Max', 'Thomas', 'Sam', 'Ruben', 'Ethan', 'Jack', 'Mason', 'Daniel', 'Ben', 'Arthur',
];

const LAST_NAMES = [
  'de Vries', 'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer', 'Mulder', 'Bos', 'Vos', 'Peters',
  'Hendriks', 'Dijkstra', 'Kok', 'de Boer', 'van Dijk', 'van Leeuwen', 'Sanders', 'Bennett',
  'Baker', 'Clark', 'Meyer', 'Kramer', 'Schouten', 'West', 'Mills', 'Coleman', 'Fox', 'Knight',
];

const ORG_DISTRIBUTION = [
  { code: 'SALES', weight: 21, costCenter: 'CC-SALES' },
  { code: 'CS', weight: 17, costCenter: 'CC-CS' },
  { code: 'OPS', weight: 12, costCenter: 'CC-OPS' },
  { code: 'IT', weight: 11, costCenter: 'CC-IT' },
  { code: 'MKT', weight: 9, costCenter: 'CC-MKT' },
  { code: 'FIN', weight: 8, costCenter: 'CC-FIN' },
  { code: 'LEGAL', weight: 5, costCenter: 'CC-LEGAL' },
  { code: 'HR', weight: 4, costCenter: 'CC-HR' },
  { code: 'FM-AMS', weight: 5, costCenter: 'CC-FM-AMS' },
  { code: 'FM-DHG', weight: 4, costCenter: 'CC-FM-DHG' },
  { code: 'FM-DBH', weight: 4, costCenter: 'CC-FM-DBH' },
];

const BUILDING_DISTRIBUTION = [
  { id: SPACE_IDS.amsA, weight: 18 },
  { id: SPACE_IDS.amsB, weight: 17 },
  { id: SPACE_IDS.amsC, weight: 15 },
  { id: SPACE_IDS.dhgA, weight: 17 },
  { id: SPACE_IDS.dhgB, weight: 16 },
  { id: SPACE_IDS.dbhA, weight: 17 },
];

const TEAM_USER_PLANS = [
  {
    seed: 'sd',
    teamId: TEAM_IDS.serviceDesk,
    count: 3,
    orgCode: 'OPS',
    defaultLocationId: SPACE_IDS.amsSite,
    roleId: ROLE_IDS.agent,
    domainScope: ['fm', 'admin'],
    locationScope: [],
    managerEmail: 'servicedesk.admin@prequest.nl',
    crossSiteGrants: [SPACE_IDS.amsC, SPACE_IDS.dhgA, SPACE_IDS.dhgB, SPACE_IDS.dbhA],
  },
  {
    seed: 'it',
    teamId: TEAM_IDS.it,
    count: 8,
    orgCode: 'IT',
    defaultLocationId: SPACE_IDS.dbhA,
    roleId: ROLE_IDS.agent,
    domainScope: ['it'],
    locationScope: [],
    managerEmail: 'it.admin@prequest.nl',
    crossSiteGrants: [SPACE_IDS.amsSite, SPACE_IDS.amsC, SPACE_IDS.dhgA, SPACE_IDS.dhgB],
  },
  {
    seed: 'hr',
    teamId: TEAM_IDS.hr,
    count: 3,
    orgCode: 'HR',
    defaultLocationId: SPACE_IDS.amsSite,
    roleId: ROLE_IDS.agent,
    domainScope: ['hr'],
    locationScope: [],
    managerEmail: 'hr.agent@prequest.nl',
    crossSiteGrants: [],
  },
  {
    seed: 'fm-ams',
    teamId: TEAM_IDS.facilitiesAmsterdam,
    count: 2,
    orgCode: 'FM-AMS',
    defaultLocationId: SPACE_IDS.amsA,
    roleId: ROLE_IDS.agent,
    domainScope: ['fm'],
    locationScope: [SPACE_IDS.amsA],
    managerEmail: 'facilities.amsterdam@prequest.nl',
    crossSiteGrants: [],
  },
  {
    seed: 'fm-dhg',
    teamId: TEAM_IDS.facilitiesDenHaag,
    count: 3,
    orgCode: 'FM-DHG',
    defaultLocationId: SPACE_IDS.dhgA,
    roleId: ROLE_IDS.agent,
    domainScope: ['fm'],
    locationScope: [SPACE_IDS.dhgA, SPACE_IDS.dhgB],
    managerEmail: 'manager.approver@prequest.nl',
    crossSiteGrants: [SPACE_IDS.dhgB],
  },
  {
    seed: 'fm-dbh',
    teamId: TEAM_IDS.facilitiesDenBosch,
    count: 3,
    orgCode: 'FM-DBH',
    defaultLocationId: SPACE_IDS.dbhA,
    roleId: ROLE_IDS.agent,
    domainScope: ['fm'],
    locationScope: [SPACE_IDS.dbhA],
    managerEmail: 'manager.approver@prequest.nl',
    crossSiteGrants: [],
  },
];

const HANDCRAFTED_CASES = [
  { title: 'Laptop keyboard failure after client visit', requestType: 'Laptop Broken', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgB, status: 'resolved' },
  { title: 'Docking station stops network handoff every morning', requestType: 'Docking Station Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgB, status: 'resolved' },
  { title: 'Printer on Amsterdam Campus floor 2 is ghosting invoices', requestType: 'Printer Problem', requester: 'servicedesk.agent@prequest.nl', locationId: SPACE_IDS.amsA, status: 'resolved' },
  { title: 'New marketing joiner needs starter setup for next Monday', requestType: 'New Starter Setup', requester: 'manager.approver@prequest.nl', locationId: SPACE_IDS.amsB, status: 'closed' },
  { title: 'Town hall setup for Amsterdam Campus atrium', requestType: 'Event Support', requester: 'servicedesk.admin@prequest.nl', locationId: SPACE_IDS.amsA, status: 'in_progress' },
  { title: 'Quarterly boardroom catering in Wijnhaven Office', requestType: 'Meeting Catering', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgA, status: 'closed' },
  { title: 'Deep clean after office refit at Singel Office', requestType: 'Deep Cleaning', requester: 'servicedesk.admin@prequest.nl', locationId: SPACE_IDS.amsC, status: 'closed' },
  { title: 'Ventilation noise in Amsterdam building B meeting wing', requestType: 'HVAC Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsB, status: 'resolved' },
  { title: 'Leak under pantry sink on Spui floor 1', requestType: 'Plumbing Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgB, status: 'resolved' },
  { title: 'Elevator in Pettelaar Park intermittently stuck on level 2', requestType: 'Elevator Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dbhA, status: 'in_progress' },
  { title: 'Badge reader at Canal Court side entrance offline', requestType: 'Access Control Fault', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsB, status: 'resolved' },
  { title: 'Open office lighting outage after breaker trip', requestType: 'Lighting Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgA, status: 'resolved' },
  { title: 'CRM access for new customer success specialist', requestType: 'CRM Access Request', requester: 'manager.approver@prequest.nl', locationId: SPACE_IDS.dbhA, status: 'closed' },
  { title: 'Password reset for finance analyst after MFA lockout', requestType: 'Password Reset', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'closed' },
  { title: 'High-priority VPN outage for field sales team', requestType: 'Network Connectivity Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsC, status: 'resolved' },
  { title: 'Software installation approval for legal review tool', requestType: 'Software Installation', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'closed' },
  { title: 'Second monitor request for hybrid finance team member', requestType: 'New Hardware Request', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'closed' },
  { title: 'Meeting room display failure before customer workshop', requestType: 'Meeting Room AV Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'resolved' },
  { title: 'Office move for Customer Success pod to Den Bosch', requestType: 'Office Move', requester: 'manager.approver@prequest.nl', locationId: SPACE_IDS.dbhA, status: 'closed' },
  { title: 'Ergonomic desk reconfiguration for legal counsel', requestType: 'Workstation Setup Change', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsC, status: 'resolved' },
  { title: 'Urgent spill cleanup in reception after coffee machine leak', requestType: 'Spill Cleanup', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'closed' },
  { title: 'Regular cleaning uplift after client event in Amsterdam', requestType: 'Cleaning Request', requester: 'servicedesk.agent@prequest.nl', locationId: SPACE_IDS.amsB, status: 'closed' },
  { title: 'Employment letter needed for mortgage application', requestType: 'Employment Letter Request', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgB, status: 'resolved' },
  { title: 'Leave balance correction for returning contractor', requestType: 'Leave Request', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dbhA, status: 'closed' },
  { title: 'Company card declined during supplier visit', requestType: 'Company Card Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsC, status: 'resolved' },
  { title: 'Expense question about overnight train reimbursement', requestType: 'Expense Question', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.dhgA, status: 'closed' },
  { title: 'Badge access request for Den Haag temporary project room', requestType: 'Badge Access Request', requester: 'manager.approver@prequest.nl', locationId: SPACE_IDS.dhgA, status: 'closed' },
  { title: 'HVAC issue in executive meeting room during heat wave', requestType: 'HVAC Issue', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsC, status: 'waiting' },
  { title: 'Amsterdam all-hands requires expanded event support', requestType: 'Event Support', requester: 'servicedesk.admin@prequest.nl', locationId: SPACE_IDS.amsB, status: 'closed' },
  { title: 'Printer failure blocks morning payroll run', requestType: 'Printer Problem', requester: 'employee.requester@prequest.nl', locationId: SPACE_IDS.amsA, status: 'resolved' },
];

const CHILD_PLAN_BY_REQUEST_TYPE = {
  'Laptop Broken': ({ refs }) => [
    { title: 'Remote diagnosis', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
    { title: 'Replacement unit logistics', vendorId: refs.vendorsByName['DeviceCycle Logistics'].id, slaId: refs.slas.executorStandard.id },
  ],
  'Monitor Issue': ({ refs }) => [
    { title: 'Remote diagnosis', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
    { title: 'Replacement unit logistics', vendorId: refs.vendorsByName['DeviceCycle Logistics'].id, slaId: refs.slas.executorStandard.id },
  ],
  'Docking Station Issue': ({ refs }) => [
    { title: 'Remote diagnosis', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
  ],
  'Meeting Room AV Issue': ({ refs }) => [
    { title: 'Remote AV triage', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
    { title: 'AV vendor on-site visit', vendorId: refs.vendorsByName['AV Horizon'].id, slaId: refs.slas.executorStandard.id },
  ],
  'New Starter Setup': ({ refs, locationId }) => [
    { title: 'Prepare IT hardware and identity', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
    { title: 'Prepare workplace and starter pack', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorScheduled.id },
    { title: 'Portal and service desk handover', teamId: TEAM_IDS.serviceDesk, slaId: refs.slas.executorStandard.id },
  ],
  'Office Move': ({ refs, locationId }) => [
    { title: 'Regional move coordination', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorScheduled.id },
    { title: 'Furniture move and relocation', vendorId: refs.vendorsByName['Metro Movers'].id, slaId: refs.slas.executorScheduled.id },
    { title: 'IT workplace enablement', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
  ],
  'Workstation Setup Change': ({ refs, locationId }) => [
    { title: 'Regional workplace assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Furniture or ergonomic adjustment', vendorId: refs.vendorsByName['Dutch Office Furnishings'].id, slaId: refs.slas.executorScheduled.id },
  ],
  'Cleaning Request': ({ refs, locationId }) => [
    { title: 'Regional facilities inspection', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Cleaning vendor execution', vendorId: refs.vendorsByName['BrightClean Services'].id, slaId: refs.slas.executorScheduled.id },
  ],
  'Spill Cleanup': ({ refs, locationId }) => [
    { title: 'Regional facilities inspection', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Cleaning vendor execution', vendorId: refs.vendorsByName['BrightClean Services'].id, slaId: refs.slas.executorScheduled.id },
  ],
  'Deep Cleaning': ({ refs, locationId }) => [
    { title: 'Regional facilities inspection', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Cleaning vendor execution', vendorId: refs.vendorsByName['BrightClean Services'].id, slaId: refs.slas.executorScheduled.id },
  ],
  'Lighting Issue': ({ refs, locationId }) => [
    { title: 'Regional electrical assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Electrical specialist dispatch', vendorId: refs.vendorsByName['VoltWorks Electrical'].id, slaId: refs.slas.executorStandard.id },
  ],
  'Plumbing Issue': ({ refs, locationId }) => [
    { title: 'Regional plumbing assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Plumbing specialist dispatch', vendorId: refs.vendorsByName['AquaFix Plumbing'].id, slaId: refs.slas.executorStandard.id },
  ],
  'HVAC Issue': ({ refs, locationId }) => [
    { title: 'Regional HVAC assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'HVAC specialist dispatch', vendorId: refs.vendorsByName['Klimaat Partners'].id, slaId: refs.slas.executorStandard.id },
  ],
  'Elevator Issue': ({ refs, locationId }) => [
    { title: 'Regional elevator assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorCritical.id },
    { title: 'Elevator specialist dispatch', vendorId: refs.vendorsByName['LiftLine Elevators'].id, slaId: refs.slas.executorCritical.id },
  ],
  'Access Control Fault': ({ refs, locationId }) => [
    { title: 'Regional access control assessment', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorStandard.id },
    { title: 'Access control specialist dispatch', vendorId: refs.vendorsByName['SecureEntry Systems'].id, slaId: refs.slas.executorStandard.id },
  ],
  'Badge Access Request': ({ refs }) => [
    { title: 'Review request and required access', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
    { title: 'Badge or controller programming', vendorId: refs.vendorsByName['SecureEntry Systems'].id, slaId: refs.slas.executorStandard.id },
  ],
  'CRM Access Request': ({ refs }) => [
    { title: 'Review request and required access', teamId: TEAM_IDS.it, slaId: refs.slas.executorStandard.id },
  ],
  'Event Support': ({ refs, locationId }) => [
    { title: 'Regional event setup', teamId: localFacilitiesTeam(locationId), slaId: refs.slas.executorScheduled.id },
    { title: 'Catering coordination', vendorId: cateringVendorForLocation(locationId, refs), slaId: refs.slas.executorScheduled.id },
    { title: 'AV setup', vendorId: refs.vendorsByName['AV Horizon'].id, slaId: refs.slas.executorStandard.id },
  ],
};

function deterministicUuid(seed) {
  const hex = createHash('sha1').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
}

function hashInt(seed) {
  return parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16);
}

function mulberry32(a) {
  return function rand() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function chunk(items, size = 200) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function weightedPick(items, rand) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = rand() * total;
  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
}

function daysAgo(dayOffset, minuteOffset = 0) {
  const now = new Date('2026-04-23T12:00:00.000Z');
  now.setUTCDate(now.getUTCDate() - dayOffset);
  now.setUTCMinutes(now.getUTCMinutes() + minuteOffset);
  return now.toISOString();
}

function localFacilitiesTeam(locationId) {
  if ([SPACE_IDS.amsA, SPACE_IDS.amsB, SPACE_IDS.amsC, SPACE_IDS.amsSite].includes(locationId)) return TEAM_IDS.facilitiesAmsterdam;
  if ([SPACE_IDS.dhgA, SPACE_IDS.dhgB].includes(locationId)) return TEAM_IDS.facilitiesDenHaag;
  return TEAM_IDS.facilitiesDenBosch;
}

function mainCaseTarget(requestType, locationId, refs) {
  if (requestType.name === 'Deep Cleaning' && locationId === SPACE_IDS.amsC) {
    return { kind: 'vendor', id: refs.vendorsByName['BrightClean Services'].id, chosenBy: 'scope_override' };
  }
  if (requestType.domain === 'hr') return { kind: 'team', id: TEAM_IDS.hr, chosenBy: 'location_team' };
  if (['hardware', 'software', 'network', 'printing', 'identity', 'av', 'it'].includes(requestType.domain)) {
    return { kind: 'team', id: TEAM_IDS.it, chosenBy: requestType.domain === 'it' ? 'location_team' : 'domain_fallback' };
  }
  return { kind: 'team', id: TEAM_IDS.serviceDesk, chosenBy: requestType.domain === 'fm' ? 'location_team' : 'domain_fallback' };
}

function cateringVendorForLocation(locationId, refs) {
  if ([SPACE_IDS.amsA, SPACE_IDS.amsB, SPACE_IDS.amsC].includes(locationId)) return refs.vendorsByName['NorthStar Catering'].id;
  if ([SPACE_IDS.dhgA, SPACE_IDS.dhgB].includes(locationId)) return refs.vendorsByName['Hofstad Catering'].id;
  return refs.vendorsByName['Bosch Bites'].id;
}

async function upsertMany(client, table, rows, onConflict = 'id') {
  for (const batch of chunk(rows)) {
    const { error } = await client.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function fetchAll(client, table, columns, filters = []) {
  let query = client.from(table).select(columns);
  for (const [kind, field, value] of filters) {
    if (kind === 'eq') query = query.eq(field, value);
    if (kind === 'in') query = query.in(field, value);
  }
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

async function ensureFixedAuthUsers(admin, refs) {
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listed.error) throw listed.error;
  const byEmail = new Map((listed.data?.users ?? []).map((user) => [user.email?.toLowerCase(), user]));

  for (const email of FIXED_LOGIN_EMAILS) {
    const publicUser = refs.fixedUsersByEmail[email];
    if (!publicUser) throw new Error(`Missing public.users row for ${email}`);

    let authUser = byEmail.get(email);
    if (!authUser) {
      const created = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (created.error) throw created.error;
      authUser = created.data.user;
    } else {
      const updated = await admin.auth.admin.updateUserById(authUser.id, {
        password: PASSWORD,
        email_confirm: true,
      });
      if (updated.error) throw updated.error;
      authUser = updated.data.user ?? authUser;
    }

    const { error } = await admin
      .from('users')
      .update({ auth_uid: authUser.id, status: 'active' })
      .eq('id', publicUser.id)
      .eq('tenant_id', TENANT_ID);
    if (error) throw error;
  }
}

function buildName(seed) {
  const rand = mulberry32(hashInt(`name:${seed}`));
  const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
  return { first, last };
}

function buildEmail(first, last, suffix, domain = 'tss-test.nl') {
  return `${slug(`${first}.${last}`)}.${suffix}@${domain}`;
}

function buildGeneratedPeople(refs) {
  const corporatePeople = [];
  const users = [];
  const assignments = [];
  const teamMembers = [];
  const orgMemberships = [];
  const locationGrants = [];
  const managers = [];

  const fixedPeopleByEmail = refs.fixedPersonsByEmail;

  for (const plan of TEAM_USER_PLANS) {
    for (let i = 0; i < plan.count; i++) {
      const seed = `${plan.seed}:${i + 1}`;
      const id = deterministicUuid(`person:${seed}`);
      const userId = deterministicUuid(`user:${seed}`);
      const { first, last } = buildName(seed);
      const email = buildEmail(first, last, `${plan.seed}${i + 1}`);
      const managerId = fixedPeopleByEmail[plan.managerEmail]?.id ?? null;

      corporatePeople.push({
        id,
        tenant_id: TENANT_ID,
        type: 'employee',
        first_name: first,
        last_name: last,
        email,
        cost_center: `${ORG_DISTRIBUTION.find((o) => o.code === plan.orgCode)?.costCenter ?? 'CC'}-${String(i + 1).padStart(3, '0')}`,
        manager_person_id: managerId,
        active: true,
        default_location_id: plan.defaultLocationId,
      });

      users.push({
        id: userId,
        tenant_id: TENANT_ID,
        person_id: id,
        auth_uid: null,
        email,
        username: slug(`${first}.${last}`),
        status: 'active',
        portal_current_location_id: plan.defaultLocationId,
      });

      assignments.push({
        id: deterministicUuid(`ura:${userId}`),
        tenant_id: TENANT_ID,
        user_id: userId,
        role_id: plan.roleId,
        domain_scope: plan.domainScope,
        location_scope: plan.locationScope,
        read_only_cross_domain: false,
        active: true,
      });

      teamMembers.push({
        id: deterministicUuid(`team-member:${plan.teamId}:${userId}`),
        tenant_id: TENANT_ID,
        team_id: plan.teamId,
        user_id: userId,
      });

      orgMemberships.push({
        id: deterministicUuid(`org:${id}`),
        tenant_id: TENANT_ID,
        person_id: id,
        org_node_id: refs.orgNodesByCode[plan.orgCode].id,
        is_primary: true,
      });

      for (const grantSpaceId of plan.crossSiteGrants) {
        locationGrants.push({
          id: deterministicUuid(`grant:${id}:${grantSpaceId}`),
          tenant_id: TENANT_ID,
          person_id: id,
          space_id: grantSpaceId,
          note: 'Cross-site execution coverage',
        });
      }
    }
  }

  const managerSeeds = [
    { key: 'sales-ams', orgCode: 'SALES', locationId: SPACE_IDS.amsA },
    { key: 'sales-dhg', orgCode: 'SALES', locationId: SPACE_IDS.dhgA },
    { key: 'marketing', orgCode: 'MKT', locationId: SPACE_IDS.amsB },
    { key: 'finance', orgCode: 'FIN', locationId: SPACE_IDS.amsA },
    { key: 'legal', orgCode: 'LEGAL', locationId: SPACE_IDS.amsC },
    { key: 'cs-dbh', orgCode: 'CS', locationId: SPACE_IDS.dbhA },
    { key: 'ops', orgCode: 'OPS', locationId: SPACE_IDS.amsSite },
    { key: 'it-manager', orgCode: 'IT', locationId: SPACE_IDS.dbhA },
    { key: 'hr-manager', orgCode: 'HR', locationId: SPACE_IDS.amsSite },
    { key: 'fm-manager', orgCode: 'FM-AMS', locationId: SPACE_IDS.amsA },
    { key: 'cs-ams', orgCode: 'CS', locationId: SPACE_IDS.amsB },
    { key: 'finance-dhg', orgCode: 'FIN', locationId: SPACE_IDS.dhgB },
  ];

  for (const [index, plan] of managerSeeds.entries()) {
    const id = deterministicUuid(`manager:${plan.key}`);
    const { first, last } = buildName(`manager:${plan.key}`);
    const email = buildEmail(first, last, `mgr${index + 1}`);
    corporatePeople.push({
      id,
      tenant_id: TENANT_ID,
      type: 'employee',
      first_name: first,
      last_name: last,
      email,
      cost_center: `${ORG_DISTRIBUTION.find((o) => o.code === plan.orgCode)?.costCenter ?? 'CC'}-M${String(index + 1).padStart(2, '0')}`,
      manager_person_id: fixedPeopleByEmail['manager.approver@prequest.nl'].id,
      active: true,
      default_location_id: plan.locationId,
    });
    orgMemberships.push({
      id: deterministicUuid(`org:${id}`),
      tenant_id: TENANT_ID,
      person_id: id,
      org_node_id: refs.orgNodesByCode[plan.orgCode].id,
      is_primary: true,
    });
    managers.push({ id, orgCode: plan.orgCode, locationId: plan.locationId });
  }

  const existingCorporate = Object.values(refs.fixedPersonsByEmail)
    .filter((person) => person.type !== 'vendor_contact')
    .length;
  const generatedCorporate = corporatePeople.length;
  const remaining = TOTAL_CORPORATE_PEOPLE - existingCorporate - generatedCorporate;

  for (let i = 0; i < remaining; i++) {
    const seed = `employee:${i + 1}`;
    const rand = mulberry32(hashInt(seed));
    const orgPick = weightedPick(ORG_DISTRIBUTION, rand);
    const buildingPick = weightedPick(BUILDING_DISTRIBUTION, rand).id;
    const managerPool = managers.filter((manager) => manager.orgCode === orgPick.code);
    const managerId = managerPool.length > 0
      ? managerPool[Math.floor(rand() * managerPool.length)].id
      : fixedPeopleByEmail['manager.approver@prequest.nl'].id;
    const { first, last } = buildName(seed);
    const personTypeRoll = rand();
    const personType = personTypeRoll < 0.04 ? 'contractor' : personTypeRoll < 0.05 ? 'temporary_worker' : 'employee';
    const active = rand() > 0.03;
    const id = deterministicUuid(`person:${seed}`);
    const email = buildEmail(first, last, String(i + 1).padStart(3, '0'));

    corporatePeople.push({
      id,
      tenant_id: TENANT_ID,
      type: personType,
      first_name: first,
      last_name: last,
      email,
      cost_center: `${orgPick.costCenter}-${String(i + 1).padStart(3, '0')}`,
      manager_person_id: managerId,
      active,
      default_location_id: buildingPick,
    });

    orgMemberships.push({
      id: deterministicUuid(`org:${id}`),
      tenant_id: TENANT_ID,
      person_id: id,
      org_node_id: refs.orgNodesByCode[orgPick.code].id,
      is_primary: true,
    });

    if (rand() < 0.22) {
      const extra = weightedPick(BUILDING_DISTRIBUTION.filter((b) => b.id !== buildingPick), rand).id;
      locationGrants.push({
        id: deterministicUuid(`grant:${id}:${extra}`),
        tenant_id: TENANT_ID,
        person_id: id,
        space_id: extra,
        note: 'Hybrid work pattern',
      });
    }
    if (rand() < 0.07) {
      const extra = weightedPick(BUILDING_DISTRIBUTION.filter((b) => b.id !== buildingPick), rand).id;
      locationGrants.push({
        id: deterministicUuid(`grant:${id}:${extra}:2`),
        tenant_id: TENANT_ID,
        person_id: id,
        space_id: extra,
        note: 'Cross-site collaboration',
      });
    }
  }

  return { corporatePeople, users, assignments, teamMembers, orgMemberships, locationGrants };
}

function buildAssets(refs, people) {
  const assets = [];
  const history = [];
  const personAssets = new Map();
  const roomAssets = [];

  const activeCorporate = people.filter((person) => person.active && person.type !== 'vendor_contact');

  for (const person of activeCorporate) {
    const seed = `assets:${person.id}`;
    const rand = mulberry32(hashInt(seed));
    const laptopId = deterministicUuid(`${seed}:laptop`);
    const dockId = deterministicUuid(`${seed}:dock`);
    const monitorPrimaryId = deterministicUuid(`${seed}:monitor:1`);
    const monitorSecondaryId = deterministicUuid(`${seed}:monitor:2`);
    const purchasedAt = daysAgo(25 + Math.floor(rand() * 120));

    assets.push({
      id: laptopId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName.Laptop.id,
      asset_role: 'personal',
      name: `${person.first_name} ${person.last_name} Laptop`,
      tag: `LAP-${person.id.slice(0, 6).toUpperCase()}`,
      serial_number: `SN-${laptopId.slice(0, 8).toUpperCase()}`,
      status: person.active ? 'assigned' : 'retired',
      assigned_person_id: person.id,
      assigned_space_id: person.default_location_id,
      assignment_type: 'permanent',
      assignment_start_at: purchasedAt,
      purchase_date: purchasedAt.slice(0, 10),
      lifecycle_state: person.active ? 'active' : 'retired',
    });
    assets.push({
      id: dockId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName.Dock.id,
      asset_role: 'personal',
      name: `${person.first_name} ${person.last_name} Dock`,
      tag: `DCK-${person.id.slice(0, 6).toUpperCase()}`,
      serial_number: `SN-${dockId.slice(0, 8).toUpperCase()}`,
      status: person.active ? 'assigned' : 'retired',
      assigned_person_id: person.id,
      assigned_space_id: person.default_location_id,
      assignment_type: 'permanent',
      assignment_start_at: purchasedAt,
      purchase_date: purchasedAt.slice(0, 10),
      lifecycle_state: person.active ? 'active' : 'retired',
    });
    assets.push({
      id: monitorPrimaryId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName.Monitor.id,
      asset_role: 'personal',
      name: `${person.first_name} ${person.last_name} Monitor`,
      tag: `MON-${person.id.slice(0, 6).toUpperCase()}`,
      serial_number: `SN-${monitorPrimaryId.slice(0, 8).toUpperCase()}`,
      status: person.active ? 'assigned' : 'retired',
      assigned_person_id: person.id,
      assigned_space_id: person.default_location_id,
      assignment_type: 'permanent',
      assignment_start_at: purchasedAt,
      purchase_date: purchasedAt.slice(0, 10),
      lifecycle_state: person.active ? 'active' : 'retired',
    });
    if (rand() < 0.42) {
      assets.push({
        id: monitorSecondaryId,
        tenant_id: TENANT_ID,
        asset_type_id: refs.assetTypesByName.Monitor.id,
        asset_role: 'personal',
        name: `${person.first_name} ${person.last_name} Secondary Monitor`,
        tag: `MON-${person.id.slice(0, 4).toUpperCase()}-2`,
        serial_number: `SN-${monitorSecondaryId.slice(0, 8).toUpperCase()}`,
        status: person.active ? 'assigned' : 'retired',
        assigned_person_id: person.id,
        assigned_space_id: person.default_location_id,
        assignment_type: 'permanent',
        assignment_start_at: purchasedAt,
        purchase_date: purchasedAt.slice(0, 10),
        lifecycle_state: person.active ? 'active' : 'retired',
      });
    }

    for (const assetId of [laptopId, dockId, monitorPrimaryId]) {
      history.push({
        id: deterministicUuid(`history:${assetId}`),
        asset_id: assetId,
        tenant_id: TENANT_ID,
        action: 'assigned',
        from_person_id: null,
        to_person_id: person.id,
        from_space_id: null,
        to_space_id: person.default_location_id,
        reason: 'Initial seeded assignment',
        performed_by_user_id: refs.fixedUsersByEmail['dev@prequest.nl'].id,
        created_at: purchasedAt,
      });
    }

    personAssets.set(person.id, {
      laptop: laptopId,
      dock: dockId,
      monitor: monitorPrimaryId,
    });
  }

  for (const room of refs.meetingRooms) {
    const displayId = deterministicUuid(`room-display:${room.id}`);
    const avKitId = deterministicUuid(`room-av:${room.id}`);
    assets.push({
      id: displayId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName['Meeting Room Display'].id,
      asset_role: 'fixed',
      name: `${room.name} Display`,
      tag: `MRD-${room.code}`,
      serial_number: `SN-${displayId.slice(0, 8).toUpperCase()}`,
      status: 'assigned',
      assigned_person_id: null,
      assigned_space_id: room.id,
      assignment_type: 'permanent',
      assignment_start_at: daysAgo(60),
      purchase_date: daysAgo(60).slice(0, 10),
      lifecycle_state: 'active',
    });
    assets.push({
      id: avKitId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName['AV Kit'].id,
      asset_role: 'fixed',
      name: `${room.name} AV Kit`,
      tag: `AVK-${room.code}`,
      serial_number: `SN-${avKitId.slice(0, 8).toUpperCase()}`,
      status: 'assigned',
      assigned_person_id: null,
      assigned_space_id: room.id,
      assignment_type: 'permanent',
      assignment_start_at: daysAgo(60),
      purchase_date: daysAgo(60).slice(0, 10),
      lifecycle_state: 'active',
    });
    roomAssets.push({ displayId, avKitId, roomId: room.id });
  }

  for (const room of refs.copyAreas) {
    const printerId = deterministicUuid(`printer:${room.id}`);
    assets.push({
      id: printerId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName.Printer.id,
      asset_role: 'fixed',
      name: `${room.name} Printer`,
      tag: `PRN-${room.code}`,
      serial_number: `SN-${printerId.slice(0, 8).toUpperCase()}`,
      status: 'assigned',
      assigned_person_id: null,
      assigned_space_id: room.id,
      assignment_type: 'permanent',
      assignment_start_at: daysAgo(90),
      purchase_date: daysAgo(90).slice(0, 10),
      lifecycle_state: 'active',
    });
    roomAssets.push({ printerId, roomId: room.id });
  }

  for (const buildingId of Object.values(SPACE_IDS).filter((id) => id !== SPACE_IDS.amsSite)) {
    for (const suffix of ['A', 'B']) {
      const hvacId = deterministicUuid(`hvac:${buildingId}:${suffix}`);
      assets.push({
        id: hvacId,
        tenant_id: TENANT_ID,
        asset_type_id: refs.assetTypesByName['HVAC Unit'].id,
        asset_role: 'fixed',
        name: `HVAC ${suffix} ${refs.spaceById[buildingId].name}`,
        tag: `HVAC-${refs.spaceById[buildingId].code}-${suffix}`,
        serial_number: `SN-${hvacId.slice(0, 8).toUpperCase()}`,
        status: 'assigned',
        assigned_person_id: null,
        assigned_space_id: buildingId,
        assignment_type: 'permanent',
        assignment_start_at: daysAgo(180),
        purchase_date: daysAgo(180).slice(0, 10),
        lifecycle_state: 'active',
      });
    }
    const elevatorId = deterministicUuid(`elevator:${buildingId}`);
    assets.push({
      id: elevatorId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName.Elevator.id,
      asset_role: 'fixed',
      name: `Lift ${refs.spaceById[buildingId].name}`,
      tag: `LFT-${refs.spaceById[buildingId].code}`,
      serial_number: `SN-${elevatorId.slice(0, 8).toUpperCase()}`,
      status: 'assigned',
      assigned_person_id: null,
      assigned_space_id: buildingId,
      assignment_type: 'permanent',
      assignment_start_at: daysAgo(220),
      purchase_date: daysAgo(220).slice(0, 10),
      lifecycle_state: 'active',
    });
    const controllerId = deterministicUuid(`controller:${buildingId}`);
    assets.push({
      id: controllerId,
      tenant_id: TENANT_ID,
      asset_type_id: refs.assetTypesByName['Door Controller'].id,
      asset_role: 'fixed',
      name: `Door Controller ${refs.spaceById[buildingId].name}`,
      tag: `ACC-${refs.spaceById[buildingId].code}`,
      serial_number: `SN-${controllerId.slice(0, 8).toUpperCase()}`,
      status: 'assigned',
      assigned_person_id: null,
      assigned_space_id: buildingId,
      assignment_type: 'permanent',
      assignment_start_at: daysAgo(210),
      purchase_date: daysAgo(210).slice(0, 10),
      lifecycle_state: 'active',
    });
  }

  const retiredAssetId = deterministicUuid('retired:laptop:legacy');
  assets.push({
    id: retiredAssetId,
    tenant_id: TENANT_ID,
    asset_type_id: refs.assetTypesByName.Laptop.id,
    asset_role: 'personal',
    name: 'Legacy Executive Laptop',
    tag: 'LAP-LEGACY-001',
    serial_number: 'SN-LEGACY-001',
    status: 'retired',
    assigned_person_id: null,
    assigned_space_id: SPACE_IDS.amsA,
    assignment_type: 'permanent',
    assignment_start_at: daysAgo(360),
    purchase_date: daysAgo(360).slice(0, 10),
    lifecycle_state: 'retired',
  });
  history.push({
    id: deterministicUuid(`history:${retiredAssetId}`),
    asset_id: retiredAssetId,
    tenant_id: TENANT_ID,
    action: 'retired',
    from_person_id: null,
    to_person_id: null,
    from_space_id: SPACE_IDS.amsA,
    to_space_id: null,
    reason: 'Retained historical asset',
    performed_by_user_id: refs.fixedUsersByEmail['dev@prequest.nl'].id,
    created_at: daysAgo(40),
  });

  return { assets, history, personAssets, roomAssets };
}

function pickRequestTypeForGenerated(rand, refs) {
  const weighted = [
    ['Laptop Broken', 8], ['Monitor Issue', 6], ['Docking Station Issue', 4], ['Printer Problem', 5],
    ['Software Installation', 5], ['Network Connectivity Issue', 6], ['Meeting Room AV Issue', 4],
    ['New Hardware Request', 3], ['Password Reset', 4], ['Badge Access Request', 3], ['CRM Access Request', 2],
    ['Office Move', 4], ['Workstation Setup Change', 5], ['Cleaning Request', 6], ['Spill Cleanup', 3],
    ['Deep Cleaning', 2], ['Lighting Issue', 6], ['Plumbing Issue', 6], ['HVAC Issue', 6], ['Elevator Issue', 3],
    ['Access Control Fault', 3], ['Leave Request', 4], ['Employment Letter Request', 3], ['New Starter Setup', 2],
    ['Meeting Catering', 3], ['Event Support', 2], ['Expense Question', 2], ['Company Card Issue', 2],
  ];
  return refs.requestTypesByName[weightedPick(weighted.map(([name, weight]) => ({ name, weight })), rand).name];
}

function compatiblePeople(requestType, refs, people) {
  if (requestType.name === 'CRM Access Request') {
    return people.filter((person) => ['SALES', 'CS'].includes(refs.personOrgCode.get(person.id)));
  }
  if (requestType.name === 'New Starter Setup') {
    return people.filter((person) => ['employee'].includes(person.type) && ['OPS', 'HR'].includes(refs.personOrgCode.get(person.id)));
  }
  if (requestType.name === 'Employment Letter Request') {
    return people.filter((person) => person.type === 'employee');
  }
  return people.filter((person) => person.type !== 'vendor_contact');
}

function locationForRequest(requestType, requester, rand) {
  if (!requestType.location_required) return requester.default_location_id ?? SPACE_IDS.amsA;
  if (requestType.name === 'Meeting Catering') {
    const choices = [SPACE_IDS.amsA, SPACE_IDS.amsB, SPACE_IDS.dhgA, SPACE_IDS.dhgB, SPACE_IDS.dbhA];
    return choices[Math.floor(rand() * choices.length)];
  }
  if (requestType.name === 'Event Support') {
    const choices = [SPACE_IDS.amsA, SPACE_IDS.amsB, SPACE_IDS.amsC, SPACE_IDS.dhgA, SPACE_IDS.dbhA];
    return choices[Math.floor(rand() * choices.length)];
  }
  if (requestType.name === 'Deep Cleaning') {
    const choices = [SPACE_IDS.amsA, SPACE_IDS.amsB, SPACE_IDS.amsC, SPACE_IDS.dhgA];
    return choices[Math.floor(rand() * choices.length)];
  }
  return requester.default_location_id ?? SPACE_IDS.amsA;
}

function assetForRequest(requestType, requesterId, refs, personAssets) {
  const owned = personAssets.get(requesterId);
  if (!owned) return null;
  if (requestType.name === 'Laptop Broken') return owned.laptop;
  if (requestType.name === 'Monitor Issue') return owned.monitor;
  if (requestType.name === 'Docking Station Issue') return owned.dock;
  if (requestType.name === 'Printer Problem') return refs.printerAssets[0] ?? null;
  return null;
}

function caseStatus(seed, requiresApproval) {
  const rand = mulberry32(hashInt(`status:${seed}`));
  const roll = rand();
  if (requiresApproval && roll < 0.05) return { status: 'awaiting_approval', category: 'pending_approval', outcome: 'pending' };
  if (requiresApproval && roll < 0.09) return { status: 'cancelled', category: 'closed', outcome: 'rejected' };
  if (roll < 0.62) return { status: 'resolved', category: 'resolved', outcome: 'approved' };
  if (roll < 0.9) return { status: 'closed', category: 'closed', outcome: 'approved' };
  if (roll < 0.95) return { status: 'waiting_vendor', category: 'waiting', outcome: 'approved' };
  if (roll < 0.98) return { status: 'assigned', category: 'assigned', outcome: 'approved' };
  return { status: 'in_progress', category: 'in_progress', outcome: 'approved' };
}

function buildCaseArtifacts({ seed, requestType, requester, requestedFor, locationId, assetId, statusInfo, refs, personAssets, handcrafted = false, titleOverride = null }) {
  const rand = mulberry32(hashInt(`case:${seed}`));
  const createdAt = daysAgo(Math.floor(rand() * 30), Math.floor(rand() * 400));
  const caseId = deterministicUuid(`ticket:${seed}`);
  const title = titleOverride ?? `${requestType.name} for ${requester.first_name} ${requester.last_name}`;
  const target = mainCaseTarget(requestType, locationId, refs);
  const priority = requestType.name === 'Elevator Issue' || requestType.name === 'Spill Cleanup'
    ? 'high'
    : rand() < 0.2 ? 'high' : 'medium';
  const waitingReason = statusInfo.category === 'waiting' ? (rand() < 0.5 ? 'vendor' : 'requester') : null;
  const resolvedAt = ['resolved', 'closed'].includes(statusInfo.category) ? daysAgo(Math.max(0, Math.floor(rand() * 28)), 800) : null;
  const closedAt = statusInfo.category === 'closed' ? daysAgo(Math.max(0, Math.floor(rand() * 27)), 920) : null;
  const description = handcrafted
    ? `${title}. Seeded curated scenario for the local TSS demo.`
    : `Seeded example for ${requestType.name.toLowerCase()}.`;

  const caseRow = {
    id: caseId,
    tenant_id: TENANT_ID,
    ticket_type_id: requestType.id,
    parent_ticket_id: null,
    ticket_kind: 'case',
    title,
    description,
    status: statusInfo.status,
    status_category: statusInfo.category,
    waiting_reason: waitingReason,
    interaction_mode: 'internal',
    priority,
    impact: priority === 'high' ? 'high' : 'medium',
    urgency: priority === 'high' ? 'high' : 'medium',
    requester_person_id: requester.id,
    requested_for_person_id: requestedFor.id,
    location_id: locationId,
    asset_id: assetId,
    assigned_team_id: target.kind === 'team' ? target.id : null,
    assigned_user_id: null,
    assigned_vendor_id: target.kind === 'vendor' ? target.id : null,
    workflow_id: statusInfo.category === 'pending_approval' ? null : requestType.workflow_definition_id,
    sla_id: requestType.sla_policy_id,
    source_channel: 'portal',
    tags: [requestType.domain, refs.spaceById[locationId]?.attributes?.city ?? 'office'].filter(Boolean),
    watchers: [],
    form_data: { seeded: true, request_type: requestType.name },
    created_at: createdAt,
    updated_at: closedAt ?? resolvedAt ?? createdAt,
    resolved_at: resolvedAt,
    closed_at: closedAt,
  };

  const childPlans = statusInfo.category === 'pending_approval' || statusInfo.status === 'cancelled'
    ? []
    : (CHILD_PLAN_BY_REQUEST_TYPE[requestType.name]?.({ refs, locationId, requester }) ?? []);

  const children = childPlans.map((plan, index) => {
    const childStatusRoll = rand();
    const childCategory = statusInfo.category === 'closed' || statusInfo.category === 'resolved'
      ? 'closed'
      : childStatusRoll < 0.6 ? 'resolved'
      : childStatusRoll < 0.8 ? 'in_progress'
      : 'waiting';
    const childResolvedAt = ['resolved', 'closed'].includes(childCategory) ? daysAgo(Math.max(0, Math.floor(rand() * 20)), 1200 + index * 20) : null;
    const childClosedAt = childCategory === 'closed' ? childResolvedAt : null;
    return {
      id: deterministicUuid(`ticket:${seed}:child:${index + 1}`),
      tenant_id: TENANT_ID,
      ticket_type_id: requestType.id,
      parent_ticket_id: caseId,
      ticket_kind: 'work_order',
      title: plan.title,
      description: `${plan.title} created from ${requestType.name}.`,
      status: childCategory === 'waiting' ? 'waiting_vendor' : childCategory,
      status_category: childCategory,
      waiting_reason: childCategory === 'waiting' ? 'vendor' : null,
      interaction_mode: 'internal',
      priority: plan.slaId === refs.slas.executorCritical.id ? 'high' : 'medium',
      impact: null,
      urgency: null,
      requester_person_id: requester.id,
      requested_for_person_id: requestedFor.id,
      location_id: locationId,
      asset_id: assetId,
      assigned_team_id: plan.teamId ?? null,
      assigned_user_id: null,
      assigned_vendor_id: plan.vendorId ?? null,
      workflow_id: null,
      sla_id: plan.slaId ?? null,
      source_channel: 'workflow',
      tags: [requestType.domain, 'child'],
      watchers: [],
      form_data: { seeded_child: true, parent_ticket_id: caseId },
      created_at: createdAt,
      updated_at: childClosedAt ?? childResolvedAt ?? createdAt,
      resolved_at: childResolvedAt,
      closed_at: childClosedAt,
    };
  });

  const activities = [
    {
      id: deterministicUuid(`activity:${caseId}:created`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      activity_type: 'system_event',
      author_person_id: null,
      visibility: 'system',
      content: null,
      attachments: [],
      metadata: { event: 'ticket_created' },
      created_at: createdAt,
    },
    {
      id: deterministicUuid(`activity:${caseId}:comment:1`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      activity_type: 'external_comment',
      author_person_id: requester.id,
      visibility: 'external',
      content: handcrafted ? 'Added by curated scenario to explain the request.' : 'Added more context after submission.',
      attachments: [],
      metadata: null,
      created_at: daysAgo(Math.max(0, Math.floor(rand() * 29)), 300),
    },
  ];

  if (caseRow.assigned_team_id || caseRow.assigned_vendor_id) {
    activities.push({
      id: deterministicUuid(`activity:${caseId}:routed`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      activity_type: 'system_event',
      author_person_id: null,
      visibility: 'system',
      content: null,
      attachments: [],
      metadata: { event: 'auto_routed', chosen_by: target.chosenBy },
      created_at: daysAgo(Math.max(0, Math.floor(rand() * 29)), 360),
    });
  }

  if (statusInfo.category === 'waiting') {
    activities.push({
      id: deterministicUuid(`activity:${caseId}:waiting`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      activity_type: 'internal_note',
      author_person_id: requestedFor.id,
      visibility: 'internal',
      content: 'Vendor scheduling is still in progress.',
      attachments: [],
      metadata: null,
      created_at: daysAgo(Math.max(0, Math.floor(rand() * 10)), 520),
    });
  }

  for (const child of children) {
    activities.push({
      id: deterministicUuid(`activity:${caseId}:child:${child.id}`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      activity_type: 'system_event',
      author_person_id: null,
      visibility: 'system',
      content: null,
      attachments: [],
      metadata: {
        event: 'dispatched',
        child_id: child.id,
        assigned_team_id: child.assigned_team_id,
        assigned_vendor_id: child.assigned_vendor_id,
      },
      created_at: createdAt,
    });
  }

  const approvals = [];
  if (requestType.requires_approval) {
    approvals.push({
      id: deterministicUuid(`approval:${caseId}`),
      tenant_id: TENANT_ID,
      target_entity_type: 'ticket',
      target_entity_id: caseId,
      approval_chain_id: deterministicUuid(`approval-chain:${caseId}`),
      step_number: 1,
      parallel_group: null,
      approver_person_id: requestType.approval_approver_person_id ?? null,
      approver_team_id: requestType.approval_approver_team_id ?? null,
      delegated_to_person_id: null,
      status: statusInfo.outcome === 'pending' ? 'pending' : statusInfo.outcome === 'rejected' ? 'rejected' : 'approved',
      requested_at: createdAt,
      responded_at: statusInfo.outcome === 'pending' ? null : daysAgo(Math.max(0, Math.floor(rand() * 28)), 120),
      comments: statusInfo.outcome === 'rejected' ? 'Rejected in seeded history.' : null,
      created_at: createdAt,
    });
  }

  const routingDecisions = [];
  if (caseRow.assigned_team_id || caseRow.assigned_vendor_id) {
    routingDecisions.push({
      id: deterministicUuid(`routing:${caseId}`),
      tenant_id: TENANT_ID,
      ticket_id: caseId,
      decided_at: createdAt,
      strategy: requestType.fulfillment_strategy ?? 'fixed',
      chosen_team_id: caseRow.assigned_team_id,
      chosen_user_id: null,
      chosen_vendor_id: caseRow.assigned_vendor_id,
      chosen_by: target.chosenBy,
      rule_id: null,
      trace: [{ step: target.chosenBy, matched: true, reason: 'seeded example data', target: target.kind === 'team' ? { kind: 'team', team_id: target.id } : { kind: 'vendor', vendor_id: target.id } }],
      context: {
        request_type_id: requestType.id,
        domain: requestType.domain,
        location_id: locationId,
        asset_id: assetId,
      },
      created_at: createdAt,
    });
  }

  const workflowInstances = [];
  const workflowEvents = [];
  if (caseRow.workflow_id && statusInfo.outcome !== 'pending') {
    const workflowId = deterministicUuid(`workflow-instance:${caseId}`);
    const workflowStatus = statusInfo.category === 'waiting' ? 'waiting' : ['resolved', 'closed'].includes(statusInfo.category) ? 'completed' : 'active';
    workflowInstances.push({
      id: workflowId,
      tenant_id: TENANT_ID,
      workflow_definition_id: caseRow.workflow_id,
      workflow_version: 1,
      ticket_id: caseId,
      current_node_id: workflowStatus === 'completed' ? 'end' : workflowStatus === 'waiting' ? 'spawn_children' : 'assign_it',
      status: workflowStatus,
      waiting_for: workflowStatus === 'waiting' ? 'child_tasks' : null,
      context: { seeded: true },
      started_at: createdAt,
      completed_at: workflowStatus === 'completed' ? (closedAt ?? resolvedAt ?? createdAt) : null,
    });
    workflowEvents.push(
      {
        id: deterministicUuid(`workflow-event:${workflowId}:1`),
        tenant_id: TENANT_ID,
        workflow_instance_id: workflowId,
        event_type: 'instance_started',
        node_id: 'trigger',
        node_type: 'trigger',
        decision: null,
        payload: {},
        created_at: createdAt,
      },
      {
        id: deterministicUuid(`workflow-event:${workflowId}:2`),
        tenant_id: TENANT_ID,
        workflow_instance_id: workflowId,
        event_type: workflowStatus === 'completed' ? 'instance_completed' : workflowStatus === 'waiting' ? 'instance_waiting' : 'node_entered',
        node_id: workflowStatus === 'completed' ? 'end' : 'spawn_children',
        node_type: workflowStatus === 'completed' ? 'end' : 'create_child_tasks',
        decision: null,
        payload: {},
        created_at: closedAt ?? resolvedAt ?? createdAt,
      },
    );
  }

  const slaTimers = [];
  for (const row of [caseRow, ...children]) {
    if (!row.sla_id) continue;
    const responseDue = new Date(row.created_at);
    responseDue.setUTCMinutes(responseDue.getUTCMinutes() + 60);
    const resolutionDue = new Date(row.created_at);
    resolutionDue.setUTCMinutes(resolutionDue.getUTCMinutes() + 480);
    const completedAt = row.closed_at ?? row.resolved_at ?? null;
    slaTimers.push(
      {
        id: deterministicUuid(`sla:${row.id}:response`),
        tenant_id: TENANT_ID,
        ticket_id: row.id,
        sla_policy_id: row.sla_id,
        timer_type: 'response',
        target_minutes: 60,
        started_at: row.created_at,
        due_at: responseDue.toISOString(),
        paused: false,
        paused_at: null,
        total_paused_minutes: 0,
        breached: completedAt ? new Date(completedAt) > responseDue : false,
        breached_at: completedAt && new Date(completedAt) > responseDue ? responseDue.toISOString() : null,
        completed_at: completedAt ? row.created_at : null,
        business_hours_calendar_id: null,
      },
      {
        id: deterministicUuid(`sla:${row.id}:resolution`),
        tenant_id: TENANT_ID,
        ticket_id: row.id,
        sla_policy_id: row.sla_id,
        timer_type: 'resolution',
        target_minutes: 480,
        started_at: row.created_at,
        due_at: resolutionDue.toISOString(),
        paused: false,
        paused_at: null,
        total_paused_minutes: 0,
        breached: completedAt ? new Date(completedAt) > resolutionDue : false,
        breached_at: completedAt && new Date(completedAt) > resolutionDue ? resolutionDue.toISOString() : null,
        completed_at: completedAt,
        business_hours_calendar_id: null,
      },
    );
  }

  const childActivities = children.flatMap((child) => ([
    {
      id: deterministicUuid(`activity:${child.id}:created`),
      tenant_id: TENANT_ID,
      ticket_id: child.id,
      activity_type: 'system_event',
      author_person_id: null,
      visibility: 'system',
      content: null,
      attachments: [],
      metadata: { event: 'ticket_created' },
      created_at: child.created_at,
    },
  ]));

  return {
    caseRow,
    children,
    activities: activities.concat(childActivities),
    approvals,
    routingDecisions,
    workflowInstances,
    workflowEvents,
    slaTimers,
  };
}

function buildTickets(refs, people, personAssets) {
  const activePeople = people.filter((person) => person.active && person.type !== 'vendor_contact');
  const byId = new Map(activePeople.map((person) => [person.id, person]));
  const cases = [];
  const activities = [];
  const approvals = [];
  const routingDecisions = [];
  const workflowInstances = [];
  const workflowEvents = [];
  const slaTimers = [];
  const children = [];

  const fixedRequester = refs.fixedPersonsByEmail['employee.requester@prequest.nl'];
  const fixedManager = refs.fixedPersonsByEmail['manager.approver@prequest.nl'];
  const handcraftedPeople = { requester: fixedRequester, manager: fixedManager };

  HANDCRAFTED_CASES.forEach((scenario, index) => {
    const requestType = refs.requestTypesByName[scenario.requestType];
    const requester = refs.fixedPersonsByEmail[scenario.requester] ?? handcraftedPeople.requester;
    const requestedFor = requestType.on_behalf_policy !== 'self_only' ? handcraftedPeople.requester : requester;
    const statusInfo = caseStatus(`handcrafted:${index}:${scenario.status}`, requestType.requires_approval);
    statusInfo.status = scenario.status === 'closed' ? 'closed' : scenario.status === 'resolved' ? 'resolved' : scenario.status === 'waiting' ? 'waiting_vendor' : scenario.status;
    statusInfo.category = scenario.status === 'closed' ? 'closed' : scenario.status === 'resolved' ? 'resolved' : scenario.status === 'waiting' ? 'waiting' : scenario.status;
    const assetId = assetForRequest(requestType, requester.id, refs, personAssets);
    const artifact = buildCaseArtifacts({
      seed: `handcrafted:${index + 1}`,
      requestType,
      requester,
      requestedFor,
      locationId: scenario.locationId,
      assetId,
      statusInfo,
      refs,
      personAssets,
      handcrafted: true,
      titleOverride: scenario.title,
    });
    cases.push(artifact.caseRow);
    children.push(...artifact.children);
    activities.push(...artifact.activities);
    approvals.push(...artifact.approvals);
    routingDecisions.push(...artifact.routingDecisions);
    workflowInstances.push(...artifact.workflowInstances);
    workflowEvents.push(...artifact.workflowEvents);
    slaTimers.push(...artifact.slaTimers);
  });

  for (let i = 0; i < GENERATED_CASE_COUNT; i++) {
    const seed = `generated:${i + 1}`;
    const rand = mulberry32(hashInt(seed));
    const requestType = pickRequestTypeForGenerated(rand, refs);
    const pool = compatiblePeople(requestType, refs, activePeople);
    const requester = pool[Math.floor(rand() * pool.length)] ?? activePeople[0];
    let requestedFor = requester;
    if (['direct_reports', 'configured_list'].includes(requestType.on_behalf_policy) && rand() < 0.25) {
      const reports = activePeople.filter((person) => person.manager_person_id === requester.id);
      if (reports.length > 0) requestedFor = reports[Math.floor(rand() * reports.length)];
    }
    const locationId = locationForRequest(requestType, requester, rand);
    const assetId = assetForRequest(requestType, requester.id, refs, personAssets);
    const statusInfo = caseStatus(seed, requestType.requires_approval);
    const artifact = buildCaseArtifacts({
      seed,
      requestType,
      requester,
      requestedFor,
      locationId,
      assetId,
      statusInfo,
      refs,
      personAssets,
    });
    cases.push(artifact.caseRow);
    children.push(...artifact.children);
    activities.push(...artifact.activities);
    approvals.push(...artifact.approvals);
    routingDecisions.push(...artifact.routingDecisions);
    workflowInstances.push(...artifact.workflowInstances);
    workflowEvents.push(...artifact.workflowEvents);
    slaTimers.push(...artifact.slaTimers);
  }

  return { cases, children, activities, approvals, routingDecisions, workflowInstances, workflowEvents, slaTimers };
}

async function loadReferences(admin) {
  const [spaces, orgNodes, teams, vendors, requestTypes, assetTypes, fixedPersons, fixedUsers] = await Promise.all([
    fetchAll(admin, 'spaces', 'id, name, code, type, attributes, parent_id', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'org_nodes', 'id, code, name', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'teams', 'id, name', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'vendors', 'id, name', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'request_types', 'id, name, domain, workflow_definition_id, sla_policy_id, requires_approval, approval_approver_team_id, approval_approver_person_id, on_behalf_policy, fulfillment_strategy, location_required', [['eq', 'tenant_id', TENANT_ID], ['eq', 'active', true]]),
    fetchAll(admin, 'asset_types', 'id, name', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'persons', 'id, first_name, last_name, email, type, manager_person_id, default_location_id, active', [['eq', 'tenant_id', TENANT_ID], ['in', 'email', FIXED_LOGIN_EMAILS]]),
    fetchAll(admin, 'users', 'id, email', [['eq', 'tenant_id', TENANT_ID], ['in', 'email', FIXED_LOGIN_EMAILS]]),
  ]);

  const requestTypeIds = requestTypes.map((rt) => rt.id);
  const [personOrgMemberships, meetingRooms, copyAreas] = await Promise.all([
    fetchAll(admin, 'person_org_memberships', 'person_id, org_node_id', [['eq', 'tenant_id', TENANT_ID]]),
    fetchAll(admin, 'spaces', 'id, name, code, parent_id', [['eq', 'tenant_id', TENANT_ID], ['eq', 'type', 'meeting_room']]),
    fetchAll(admin, 'spaces', 'id, name, code, parent_id, attributes', [['eq', 'tenant_id', TENANT_ID], ['eq', 'type', 'common_area']]),
  ]);
  const variants = await fetchAll(admin, 'request_type_form_variants', 'request_type_id, form_schema_id', [['eq', 'tenant_id', TENANT_ID], ['in', 'request_type_id', requestTypeIds]]);

  const spaceById = Object.fromEntries(spaces.map((space) => [space.id, space]));
  const orgNodesByCode = Object.fromEntries(orgNodes.map((node) => [node.code, node]));
  const orgNodesById = Object.fromEntries(orgNodes.map((node) => [node.id, node]));
  const teamsByName = Object.fromEntries(teams.map((team) => [team.name, team]));
  const vendorsByName = Object.fromEntries(vendors.map((vendor) => [vendor.name, vendor]));
  const requestTypesByName = Object.fromEntries(requestTypes.map((rt) => [rt.name, { ...rt, form_schema_id: variants.find((variant) => variant.request_type_id === rt.id)?.form_schema_id ?? null }]));
  const assetTypesByName = Object.fromEntries(assetTypes.map((assetType) => [assetType.name, assetType]));
  const fixedPersonsByEmail = Object.fromEntries(fixedPersons.map((person) => [person.email.toLowerCase(), person]));
  const fixedUsersByEmail = Object.fromEntries(fixedUsers.map((user) => [user.email.toLowerCase(), user]));
  const personOrgCode = new Map(
    personOrgMemberships.map((membership) => [
      membership.person_id,
      orgNodes.find((node) => node.id === membership.org_node_id)?.code ?? null,
    ]),
  );

  const filteredCopyAreas = copyAreas.filter((space) => space.attributes?.room_kind === 'copy');

  return {
    spaceById,
    orgNodesByCode,
    orgNodesById,
    teamsByName,
    vendorsByName,
    requestTypesByName,
    assetTypesByName,
    fixedPersonsByEmail,
    fixedUsersByEmail,
    personOrgCode,
    meetingRooms,
    copyAreas: filteredCopyAreas,
    printerAssets: [],
    slas: {
      executorStandard: { id: 'a3000000-0000-0000-0000-000000000007' },
      executorCritical: { id: 'a3000000-0000-0000-0000-000000000008' },
      executorScheduled: { id: 'a3000000-0000-0000-0000-000000000009' },
    },
  };
}

function parseStatusEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Stopped services:') || trimmed.startsWith('A new version of Supabase CLI is available:') || trimmed.startsWith('We recommend updating regularly')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator);
    let value = trimmed.slice(separator + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadLocalSupabaseConfig() {
  try {
    const output = execFileSync('supabase', ['status', '-o', 'env'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = parseStatusEnv(output);
    const url = parsed.API_URL;
    const secret = parsed.SECRET_KEY ?? parsed.SERVICE_ROLE_KEY;
    if (!url || !secret) return null;
    return { url, secret, source: 'local_supabase_status' };
  } catch {
    return null;
  }
}

function resolveSupabaseConfig() {
  const envUrl = process.env.SUPABASE_URL;
  const envSecret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (envUrl && envSecret) {
    const hostname = new URL(envUrl).hostname;
    const isLocal = ['127.0.0.1', 'localhost'].includes(hostname);
    if (isLocal || process.env.ALLOW_REMOTE_DEMO_SEED === 'true') {
      return { url: envUrl, secret: envSecret, source: 'environment' };
    }

    const local = loadLocalSupabaseConfig();
    if (local) {
      console.warn(`SUPABASE_URL points to non-local host "${hostname}". Falling back to local Supabase status env for demo seeding.`);
      return local;
    }

    throw new Error(`Refusing to seed non-local Supabase host "${hostname}". Set ALLOW_REMOTE_DEMO_SEED=true to override.`);
  }

  const local = loadLocalSupabaseConfig();
  if (local) return local;

  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY are required, or run local Supabase so the script can discover them via `supabase status -o env`.');
}

async function main() {
  const { url, secret } = resolveSupabaseConfig();

  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

  const refs = await loadReferences(admin);
  await ensureFixedAuthUsers(admin, refs);

  const generatedPeople = buildGeneratedPeople(refs);
  for (const membership of generatedPeople.orgMemberships) {
    const orgNode = refs.orgNodesById[membership.org_node_id];
    if (orgNode) refs.personOrgCode.set(membership.person_id, orgNode.code);
  }
  const allPeople = [...Object.values(refs.fixedPersonsByEmail), ...generatedPeople.corporatePeople];

  await upsertMany(admin, 'persons', generatedPeople.corporatePeople);
  await upsertMany(admin, 'users', generatedPeople.users);
  await upsertMany(admin, 'user_role_assignments', generatedPeople.assignments);
  await upsertMany(admin, 'team_members', generatedPeople.teamMembers);
  await upsertMany(admin, 'person_org_memberships', generatedPeople.orgMemberships);
  await upsertMany(admin, 'person_location_grants', generatedPeople.locationGrants);

  const { assets, history, personAssets, roomAssets } = buildAssets(refs, allPeople);
  refs.printerAssets = roomAssets.map((roomAsset) => roomAsset.printerId).filter(Boolean);
  await upsertMany(admin, 'assets', assets);
  await upsertMany(admin, 'asset_assignment_history', history);

  const ticketData = buildTickets(refs, allPeople, personAssets);
  await upsertMany(admin, 'tickets', ticketData.cases);
  await upsertMany(admin, 'tickets', ticketData.children);
  await upsertMany(admin, 'ticket_activities', ticketData.activities);
  await upsertMany(admin, 'approvals', ticketData.approvals);
  await upsertMany(admin, 'routing_decisions', ticketData.routingDecisions);
  await upsertMany(admin, 'workflow_instances', ticketData.workflowInstances);
  await upsertMany(admin, 'workflow_instance_events', ticketData.workflowEvents);
  await upsertMany(admin, 'sla_timers', ticketData.slaTimers);

  console.log(JSON.stringify({
    variant: 'centralised-example-data-seed',
    people_inserted: generatedPeople.corporatePeople.length,
    users_inserted: generatedPeople.users.length,
    assets_inserted: assets.length,
    cases_inserted: ticketData.cases.length,
    work_orders_inserted: ticketData.children.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
