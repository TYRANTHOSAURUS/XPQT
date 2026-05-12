import { describe, expect, it } from 'vitest';
import type {
  PlanningLaneId,
  WorkOrderPlanningBlock,
} from '@prequest/shared';
import { deriveLanesFromBlocks } from './lanes';

function makeBlock(
  id: string,
  lane: PlanningLaneId,
  planned: boolean,
): WorkOrderPlanningBlock {
  return {
    id,
    module_number: Number(id.replace(/\D/g, '')) || 1,
    title: `Block ${id}`,
    status_category: 'in_progress',
    priority: 'medium',
    planned_start_at: planned ? '2026-05-12T09:00:00.000Z' : null,
    planned_duration_minutes: planned ? 60 : null,
    sla_resolution_due_at: null,
    lane,
    request_type: null,
    can_plan: true,
  };
}

const userAlex: PlanningLaneId = { kind: 'user', id: 'u-alex', label: 'Alex' };
const userBrenda: PlanningLaneId = { kind: 'user', id: 'u-brenda', label: 'Brenda' };
const teamFM: PlanningLaneId = { kind: 'team', id: 't-fm', label: 'Facilities' };
const vendorAcme: PlanningLaneId = { kind: 'vendor', id: 'v-acme', label: 'Acme' };
const unassigned: PlanningLaneId = { kind: 'unassigned', id: null, label: 'Unassigned' };

describe('deriveLanesFromBlocks', () => {
  it('case 1 — only planned blocks → lanes match the planned set with their blocks', () => {
    const planned = [
      makeBlock('wo-1', userAlex, true),
      makeBlock('wo-2', userAlex, true),
      makeBlock('wo-3', teamFM, true),
    ];
    const lanes = deriveLanesFromBlocks(planned, []);

    expect(lanes).toHaveLength(2);
    expect(lanes[0].id).toEqual(userAlex);
    expect(lanes[0].blocks.map((b) => b.id)).toEqual(['wo-1', 'wo-2']);
    expect(lanes[1].id).toEqual(teamFM);
    expect(lanes[1].blocks.map((b) => b.id)).toEqual(['wo-3']);
  });

  it('case 2 — only unscheduled blocks → lanes match the unscheduled set with empty block arrays', () => {
    // Unscheduled blocks register a lane as a drop target but DO NOT
    // populate that lane's blocks[] — rail items render in the rail,
    // never on the grid. The asserts double-check the grid-side stays
    // empty even though the lane shows up.
    const unscheduledBlocks = [
      makeBlock('wo-4', userBrenda, false),
      makeBlock('wo-5', vendorAcme, false),
    ];
    const lanes = deriveLanesFromBlocks([], unscheduledBlocks);

    expect(lanes).toHaveLength(2);
    expect(lanes[0].id).toEqual(userBrenda);
    expect(lanes[0].blocks).toEqual([]);
    expect(lanes[1].id).toEqual(vendorAcme);
    expect(lanes[1].blocks).toEqual([]);
  });

  it('case 3 — empty arrays → empty lane list', () => {
    expect(deriveLanesFromBlocks([], [])).toEqual([]);
  });

  it('case 4 — duplicate lane keys across planned + unscheduled are deduped, planned blocks preserved', () => {
    // Alex shows up in BOTH planned and unscheduled; she should be
    // represented exactly once, with her planned block on the grid
    // (the rail block is registered as a drop target but not pushed).
    const planned = [
      makeBlock('wo-10', userAlex, true),
      makeBlock('wo-11', userBrenda, true),
    ];
    const unscheduled = [
      makeBlock('wo-20', userAlex, false), // same lane as wo-10
      makeBlock('wo-21', unassigned, false),
    ];
    const lanes = deriveLanesFromBlocks(planned, unscheduled);

    const keys = lanes.map((l) => `${l.id.kind}:${l.id.id ?? '∅'}`);
    expect(keys).toEqual([
      'user:u-alex',
      'user:u-brenda',
      'unassigned:∅',
    ]);
    // Alex's lane holds only the planned block — the rail block is NOT
    // pushed onto blocks[] (rail items render in the rail, not on the
    // grid).
    const alexLane = lanes[0];
    expect(alexLane.blocks.map((b) => b.id)).toEqual(['wo-10']);
  });
});
