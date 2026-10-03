/**
 * Combining a whole-floor run with room studies: inside a studied room the
 * finer room result replaces the floor result; everywhere else the floor
 * result stands.
 */

import { Facility, FacilityResults, SpeedSection, SpeedSlice } from './types';
import { roomAt } from './geometry';

export interface CombinedResults {
  /** Floor result with room studies merged in (null if neither exists) */
  results: FacilityResults | null;
  /** Speed maps to draw: the floor's, then each room study's on top */
  slices: SpeedSlice[];
  sections: SpeedSection[];
  /** Rooms shown at room-study resolution */
  detailed: Set<string>;
}

export function combineResults(
  facility: Facility,
  floor: FacilityResults | null,
  rooms: FacilityResults[]
): CombinedResults {
  const detailed = new Set(rooms.flatMap((r) => r.roomIds ?? []));
  const slices = [...(floor ? [floor.slice] : []), ...rooms.map((r) => r.slice)].filter(Boolean);
  const sections = rooms.flatMap((r) => (r.section ? [r.section] : []));
  const base = floor ?? rooms[0] ?? null;
  if (!base) return { results: null, slices, sections, detailed };

  const inDetailed = (x: number, y: number) => {
    const id = roomAt(facility, x, y)?.id;
    return id !== undefined && detailed.has(id);
  };
  const keepFloor = floor
    ? {
        streamlines: floor.streamlines.filter((s) =>
          s.roomId ? !detailed.has(s.roomId) : !inDetailed(s.points[0], s.points[1])
        ),
        vectors: floor.vectors.filter((v) => !inDetailed(v.p[0], v.p[1])),
        deadZones: floor.deadZones.filter((z) => !(z.roomId && detailed.has(z.roomId))),
        rooms: floor.rooms.filter((r) => !detailed.has(r.roomId)),
      }
    : { streamlines: [], vectors: [], deadZones: [], rooms: [] };

  const roomFigures = rooms.flatMap((r) => r.rooms.filter((x) => (r.roomIds ?? []).includes(x.roomId)));
  const results: FacilityResults = {
    ...base,
    streamlines: [...keepFloor.streamlines, ...rooms.flatMap((r) => r.streamlines)],
    vectors: [...keepFloor.vectors, ...rooms.flatMap((r) => r.vectors)],
    deadZones: [...keepFloor.deadZones, ...rooms.flatMap((r) => r.deadZones)],
    rooms: [...keepFloor.rooms, ...roomFigures],
    statistics: {
      maxVelocity: Math.max(base.statistics.maxVelocity, ...rooms.map((r) => r.statistics.maxVelocity)),
      avgVelocity: base.statistics.avgVelocity,
    },
  };
  return { results, slices, sections, detailed };
}
