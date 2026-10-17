// The model explains these calculations; it never invents or selects coordinates.
const kinds = [
  ['grocery', /магазин|супермаркет|продуктов/iu],
  ['school', /школ/iu],
  ['clinic', /поликлиник|больниц/iu],
  ['bus_stop', /останов/iu],
  ['park', /парк(?!овк)|сквер/iu],
  ['community', /районн[а-я]* центр/iu],
  ['playground', /детск[а-я]* площад/iu],
  ['parking', /парков/iu],
  ['waste_bin', /урн/iu],
];
export function placementIntent(question, scenario) {
  const requested =
    /мест|точк|размещ|располож|постав|постро|откры|строит|перен|перемест|добав|установ|где|куда|локаци/iu.test(
      question,
    ) && /где|куда|най[дт]|подбер|выбер|выбор|лучш|оптималь|сравни|перенес|перенос|перемест/iu.test(question);
  if (!requested) return null;
  let matches = kinds.filter(([, pattern]) => pattern.test(question)).map(([kind]) => kind);
  if (!matches.length && /объект|его|её|ее/iu.test(question)) {
    matches = [...new Set((scenario.design?.objects ?? []).filter((o) => o.active).map((o) => o.kind))];
  }
  if (matches.length !== 1)
    return { clarification: 'Уточните тип объекта, для которого нужно подобрать место.' };
  if (matches[0] === 'park')
    return {
      clarification:
        'Для сравнения парков сначала задайте границы участков: одной точки недостаточно для расчёта площади и входов.',
    };
  return { kind: matches[0], additional: /ещ[её]|дополн|второй|второго/iu.test(question) };
}

export async function analyzeQuestion(engine, input, report, signal) {
  signal?.throwIfAborted();
  const { OBJECT_KINDS, DEFAULT_DESIGN_RULES, newObject, relocateWithContext, compareDistances } =
    await import('../dist/engine.js');
  const current = engine.materialize(input.scenario).data;
  const homes = current.buildings.filter((b) => b.population?.total > 0);
  const fact = (id, label, value, unit, method) => report.facts.push({ id, label, value, unit, method });
  fact(
    'housing.homes',
    'Жилые дома в сценарии',
    homes.length,
    'домов',
    'Здания с ненулевым населением в текущей модели. Число домов не заменяет оценку населения.',
  );
  fact(
    'housing.children',
    'Жители младше совершеннолетия',
    homes.reduce((s, h) => s + (h.population.ageGroups.under18 ?? 0), 0),
    'жителей',
    'Модельный возрастной состав, а не число школьников или заявлений в школу.',
  );
  for (const [kind] of kinds) {
    const objects = current.destinations.filter((d) => d.active && d.kind === kind);
    fact(
      `supply.${kind}.count`,
      `${OBJECT_KINDS[kind]}: действующие объекты`,
      objects.length,
      'объектов',
      'Все активные объекты этого типа в текущем сценарии; объекты за границей района не учтены.',
    );
    fact(
      `supply.${kind}.capacity`,
      `${OBJECT_KINDS[kind]}: известная вместимость`,
      objects.some((d) => d.capacity === null) ? null : objects.reduce((s, d) => s + d.capacity, 0),
      'мест',
      'Сумма вместимостей, только если известны все. Это не посещаемость за час и не доказательство наличия свободных мест. Для остановки вместимость не означает наличие рейсов.',
    );
  }
  const intent = placementIntent(input.question, input.scenario);
  if (!intent) return;
  if (intent.clarification) {
    report.locationAnalysis = {
      status: 'clarification',
      scope: intent.clarification,
      alternatives: [],
      bestId: null,
    };
    return;
  }
  const kind = intent.kind;
  const originalIds = new Set(engine.getDataset().destinations.map((o) => o.id));
  // Only a single newly drawn object can be replaced implicitly. Existing district
  // facilities and other edits always stay in place; no user state is mutated.
  const additions = (input.scenario.design?.objects ?? []).filter(
    (o) => o.active && o.kind === kind && o.id.startsWith('user_') && !originalIds.has(o.id),
  );
  const replacing = !intent.additional && additions.length === 1 ? additions[0] : null;
  if (/перенес|перенос|перемест/iu.test(input.question) && !replacing) {
    report.locationAnalysis = {
      status: 'clarification',
      scope:
        'Для поиска места переноса выберите один новый объект этого типа. Перенос существующих объектов этим поиском не рассчитан.',
      alternatives: [],
      bestId: null,
    };
    return;
  }
  const base = structuredClone(input.scenario);
  const rules = base.design?.rules ?? { ...DEFAULT_DESIGN_RULES };
  base.design = { rules, objects: (base.design?.objects ?? []).filter((o) => o.id !== replacing?.id) };
  const data = engine.materialize(base).data;
  const usedIds = new Set([...data.destinations.map((d) => d.id), ...base.design.objects.map((o) => o.id)]);
  let candidateId = 'user_ai_candidate';
  while (usedIds.has(candidateId)) candidateId += '_next';
  const search = await engine.analyzeDesign(
    { mode: 'needs', kind, scenario: base, profileId: input.profileId, placementAware: true },
    { signal },
  );
  const choices = [
    { id: 'unchanged', label: replacing ? 'Без нового объекта' : 'Оставить как сейчас', scenario: base },
  ];
  if (replacing)
    choices.push({
      id: 'current',
      label: 'Текущее размещение',
      scenario: input.scenario,
      point: replacing.entrances[0],
    });
  let rejected = 0;
  for (const candidate of search.top) {
    signal?.throwIfAborted();
    try {
      const object = relocateWithContext(
        data,
        replacing ?? newObject(kind, candidate.point, candidateId),
        candidate.point,
        base.design.objects,
        rules.snapDistanceM,
      );
      const scenario = { ...base, design: { rules, objects: [...base.design.objects, object] } };
      engine.evaluate(scenario, [input.profileId]); // Includes budget and topology validation.
      const id = `option_${choices.filter((x) => x.id.startsWith('option_')).length}`;
      choices.push({
        id,
        label: `Вариант ${'АБВ'[Number(id.slice(7))]}`,
        scenario,
        point: object.entrances[0],
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      rejected++;
    }
  }
  const compared = await engine.analyzeDesign(
    {
      mode: 'compare',
      kind,
      scenario: base,
      profileId: input.profileId,
      scenarios:
        choices.length > 1
          ? choices.map((c) => ({ name: c.label, scenario: c.scenario }))
          : [
              { name: choices[0].label, scenario: base },
              { name: 'Проверка исходного', scenario: base },
            ],
    },
    { signal },
  );
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  const first = compared.comparisons[0];
  const baseTime = engine.evaluate(base, [input.profileId]).profiles[input.profileId];
  const alternatives = choices.map((choice, index) => {
    const item = compared.comparisons[index];
    const change = compareDistances(first.rows, item.rows, rules.distanceThresholdM);
    const beforeRows = new Map(first.rows.map((r) => [r.buildingId, r]));
    const improvedHomes = item.rows.filter(
      (r) => (r.distanceM ?? Infinity) < (beforeRows.get(r.buildingId)?.distanceM ?? Infinity) - 0.01,
    ).length;
    const nextTime = engine.evaluate(choice.scenario, [input.profileId]).profiles[input.profileId];
    const oldTimes = new Map(baseTime.perBuilding.map((h) => [h.buildingId, h.destinations[kind]]));
    let common = 0,
      timeChange = 0;
    for (const h of nextTime.perBuilding) {
      const a = oldTimes.get(h.buildingId),
        b = h.destinations[kind];
      if (a?.travelSeconds != null && b?.travelSeconds != null) {
        common += b.evaluatedResidents;
        timeChange += (b.travelSeconds - a.travelSeconds) * b.evaluatedResidents;
      }
    }
    const nearby = choice.point
      ? homes
          .map((h) => ({
            name: h.name,
            distance: Math.min(
              ...h.entranceNodeIds.map((id) => {
                const p = nodes.get(id)?.xy;
                return p ? Math.hypot(p[0] - choice.point[0], p[1] - choice.point[1]) : Infinity;
              }),
            ),
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 2)
          .map((h) => h.name)
      : [];
    const row = {
      id: choice.id,
      label: choice.label,
      location: nearby.length ? `Ориентир: ${nearby.join('; ')}` : '',
      ...(choice.point ? { point: choice.point } : {}),
      withinResidents: item.totals.withinResidents,
      gainedResidents: change.gainedWithinResidents,
      improvedResidents: change.improvedResidents,
      improvedHomes,
      worsenedResidents: change.worsenedResidents,
      reachableResidents: item.totals.reachableResidents,
      meanDistanceM: item.totals.meanDistanceM,
      meanReductionM: change.meanChangeCommonM === null ? null : -change.meanChangeCommonM,
      meanMinutes:
        nextTime.destinations[kind]?.meanSecondsReachableOnly == null
          ? null
          : nextTime.destinations[kind].meanSecondsReachableOnly / 60,
      savedMinutes: common ? -timeChange / common / 60 : null,
      addedCostRub: item.costRub - first.costRub,
    };
    for (const [field, label, unit, method] of [
      [
        'withinResidents',
        'жители в пределах порога',
        'жителей',
        'Кратчайший путь по доступной сети не превышает выбранный порог расстояния.',
      ],
      [
        'gainedResidents',
        'дополнительно в пределах порога',
        'жителей',
        'По сравнению с вариантом без нового объекта; население каждого дома учитывается один раз.',
      ],
      [
        'improvedResidents',
        'путь стал короче',
        'жителей',
        'Сравнение кратчайшего расстояния по каждому дому; включает новую достижимость.',
      ],
      [
        'improvedHomes',
        'дома с улучшением',
        'домов',
        'Число жилых домов, у которых путь стал короче либо появился.',
      ],
      [
        'worsenedResidents',
        'путь стал длиннее',
        'жителей',
        'Сравнение расстояний с вариантом без нового объекта.',
      ],
      [
        'meanDistanceM',
        'среднее расстояние',
        'м',
        'Среднее по населению достижимых домов. При разной достижимости сравнивайте сокращение для общей группы.',
      ],
      [
        'meanReductionM',
        'сокращение пути',
        'м',
        'Взвешенное по населению сокращение расстояния только для общей достижимой группы.',
      ],
      [
        'savedMinutes',
        'экономия времени',
        'мин',
        'Взвешенное по населению сокращение кратчайшего времени только для общей достижимой группы выбранного профиля.',
      ],
      [
        'addedCostRub',
        'дополнительная стоимость',
        '₽',
        'Разница стоимости сценария и варианта без нового объекта. Условные цены модели.',
      ],
    ])
      fact(`location.${row.id}.${field}`, `${row.label}: ${label}`, row[field], unit, method);
    return row;
  });
  const ranked = [...alternatives].sort(
    (a, b) =>
      b.withinResidents - a.withinResidents ||
      b.reachableResidents - a.reachableResidents ||
      (b.meanReductionM ?? 0) - (a.meanReductionM ?? 0) ||
      a.addedCostRub - b.addedCostRub ||
      a.id.localeCompare(b.id),
  );
  const winner = ranked[0];
  const comparison = alternatives.map((a) => ({
    id: a.id,
    label: a.label,
    conclusion:
      a.id === winner.id
        ? 'Выбран по указанному порядку критериев доступности; это не доказательство необходимости строительства.'
        : [
            a.withinResidents === winner.withinResidents
              ? 'Охват равен выбранному варианту.'
              : 'Охват меньше, чем у выбранного варианта.',
            (a.meanReductionM ?? 0) < (winner.meanReductionM ?? 0) - 0.01
              ? 'Сокращение пути меньше, чем у выбранного варианта.'
              : 'По сокращению пути не уступает выбранному варианту.',
            a.addedCostRub < winner.addedCostRub
              ? 'Требует меньше дополнительных затрат.'
              : a.addedCostRub === winner.addedCostRub
                ? 'Дополнительные затраты одинаковы.'
                : 'Требует больше дополнительных затрат.',
          ].join(' '),
  }));
  fact(
    'location.checked',
    'Проверено точек по сети',
    search.evaluatedCandidates,
    'точек',
    'Дискретная выборка доступной сети с проверкой эскизного размещения; это не все возможные участки города.',
  );
  fact(
    'location.threshold',
    'Порог расстояния в поиске',
    rules.distanceThresholdM,
    'м',
    'Настройка сценария, а не заключение о соответствии СанПиН.',
  );
  fact(
    'location.uncovered',
    'За пределами порога без нового объекта',
    first.totals.evaluatedResidents - first.totals.withinResidents,
    'жителей',
    'Потребность в улучшении доступности с учётом всех существующих объектов этого типа. Не гарантированный спрос или дефицит вместимости.',
  );
  report.locationAnalysis = {
    status: 'ready',
    kind: OBJECT_KINDS[kind],
    bestId: ranked[0].id,
    checked: search.evaluatedCandidates,
    thresholdM: rules.distanceThresholdM,
    scope: replacing
      ? 'Сравниваем места для вашего нового объекта. Остальные изменения сохранены.'
      : 'Сравниваем добавление одного объекта к текущему сценарию и вариант без добавления.',
    method:
      'Сначала охват жителей в пределах порога, затем достижимость, затем сокращение пути с учётом населения, при равном эффекте — меньшая стоимость. Предварительный поиск по сети; полный пересчёт лучших разнесённых точек и текущего варианта.',
    limitation: `Лучший среди проверенных вариантов, а не доказанный оптимум всего города. Шаг выборки: ${search.spacingM.toFixed(1)} м. ${rejected ? 'Часть финальных вариантов не прошла проверку сценария или бюджета. ' : ''}Население и цены модельные. Проверка земли, фактического спроса, вместимости и нормативов требует дополнительных данных. Часовые потоки этим поиском не оцениваются.`,
    alternatives,
    comparison,
  };
}
