export function designSchema(destinationKind) {
  const xy = {
    type: 'array',
    items: { type: 'number', minimum: -100000, maximum: 100000 },
    minItems: 2,
    maxItems: 2,
  };
  const rules = {
    type: 'object',
    additionalProperties: false,
    properties: {
      distanceThresholdM: { type: 'number', minimum: 10, maximum: 5000 },
      parkM2PerVisitor: { type: 'number', minimum: 1, maximum: 100 },
      snapDistanceM: { type: 'number', minimum: 1, maximum: 200 },
      entranceGapM: { type: 'number', minimum: 0, maximum: 100 },
      candidateSpacingM: { type: 'number', minimum: 20, maximum: 500 },
    },
    required: [
      'distanceThresholdM',
      'parkM2PerVisitor',
      'snapDistanceM',
      'entranceGapM',
      'candidateSpacingM',
    ],
  };
  const item = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 96 },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      kind: destinationKind,
      active: { type: 'boolean' },
      level: { type: 'integer', minimum: 0, maximum: 2 },
      capacity: { anyOf: [{ type: 'integer', minimum: 0, maximum: 1000000 }, { type: 'null' }] },
      entrances: { type: 'array', items: xy, maxItems: 64 },
      polygon: { anyOf: [{ type: 'null' }, { type: 'array', items: xy, minItems: 4, maxItems: 65 }] },
      site: { type: 'array', items: xy, minItems: 4, maxItems: 65 },
      placementChecked: {type:'boolean'},
      autoEntrances: { type: 'boolean' },
      throughAccess: { type: 'boolean' },
    },
    required: [
      'id',
      'name',
      'kind',
      'active',
      'level',
      'capacity',
      'entrances',
      'polygon',
      'autoEntrances',
      'throughAccess',
    ],
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: { objects: { type: 'array', items: item, maxItems: 128 }, rules },
    required: ['objects', 'rules'],
  };
}
