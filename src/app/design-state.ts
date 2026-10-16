import type { ScenarioInput, EditableObject, XY } from '../core/types.js';
import { DEFAULT_DESIGN_RULES } from '../core/design-rules.js';
export function upsertObject(scenario: ScenarioInput, object: EditableObject): ScenarioInput {
  return {
    ...scenario,
    design: {
      rules: { ...(scenario.design?.rules ?? DEFAULT_DESIGN_RULES) },
      objects: [
        ...(scenario.design?.objects ?? []).filter((o) => o.id !== object.id),
        structuredClone(object),
      ],
    },
  };
}
export function dragObject(
  original: EditableObject,
  start: XY,
  point: XY,
  part: 'object' | 'vertex' | 'entrance',
  index: number,
): EditableObject {
  const next = structuredClone(original),
    dx = point[0] - start[0],
    dy = point[1] - start[1];
  if (part === 'object') {
    next.entrances = original.entrances.map((p) => [p[0] + dx, p[1] + dy]);
    if (original.polygon) next.polygon = original.polygon.map((p) => [p[0] + dx, p[1] + dy]);
  }
  if (part === 'vertex' && next.polygon) {
    next.polygon[index] = point;
    if (index === 0) next.polygon[next.polygon.length - 1] = [...point];
  }
  if (part === 'entrance') {
    next.autoEntrances = false;
    next.entrances[index] = point;
  }
  return next;
}
