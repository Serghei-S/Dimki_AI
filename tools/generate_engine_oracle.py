"""Independent Python oracle for exact project search; not needed by the website."""
import hashlib
import json
from pathlib import Path
from district_model import materialize, adjacency, shortest_to_targets

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'data/district.json'
data = json.loads(path.read_text(encoding='utf-8'))
cases = []
for profile_id, kind, budget in [('walk', 'park', 8000000), ('step_free', 'bus_stop', 3000000)]:
    feasible = 0
    best = []
    projects = data['projects']
    for mask in range(2 ** len(projects)):
        selected = [p for i, p in enumerate(projects) if mask & (1 << i)]
        ids = {p['id'] for p in selected}
        groups = [p['exclusiveGroup'] for p in selected if p['exclusiveGroup']]
        cost = sum(p['cost']['capexRub'] for p in selected)
        if cost > budget or len(groups) != len(set(groups)):
            continue
        if any(not set(p['requires']) <= ids or set(p['excludes']) & ids for p in selected):
            continue
        district, costs = materialize(data, {'projectIds': [p['id'] for p in selected], 'budgetRub': budget, 'operationalOverrides': []})
        graph = adjacency(district, profile_id)
        targets = [n for d in district['destinations'] if d['active'] and d['kind'] == kind for n in d['accessNodeIds']]
        distances, _, _ = shortest_to_targets(graph, targets)
        covered = reachable = 0
        weighted = 0.0
        for home in district['buildings']:
            if not home['population']:
                continue
            time = min(distances.get(n, float('inf')) for n in home['entranceNodeIds'])
            pop = home['population']['total']
            if time != float('inf'):
                reachable += pop
                weighted += pop * time
                if time <= data['metricDefinitions']['thresholdSeconds'][kind] + 1e-9:
                    covered += pop
        score = {'withinThresholdResidents': covered, 'reachableResidents': reachable,
                 'weightedTravelSecondsReachable': round(weighted, 6), 'capexRub': costs['capexRub'], 'annualOpexRub': costs['annualOpexRub']}
        best.append({'projectIds': sorted(ids), 'score': score})
        feasible += 1
    best.sort(key=lambda x: (-x['score']['withinThresholdResidents'], -x['score']['reachableResidents'],
                            x['score']['weightedTravelSecondsReachable'], x['score']['capexRub'], x['score']['annualOpexRub'], '|'.join(x['projectIds'])))
    # Independent full-list Pareto filter, intentionally different from the TS
    # incremental bounded-frontier implementation. Sorting puts equivalent winners first.
    unique = []
    seen_scores = set()
    for item in best:
        s = item['score']
        vector = (-s['withinThresholdResidents'], -s['reachableResidents'], s['weightedTravelSecondsReachable'], s['capexRub'], s['annualOpexRub'])
        if vector not in seen_scores:
            unique.append((vector, item))
            seen_scores.add(vector)
    frontier = [item for vector, item in unique if not any(other != vector and all(a <= b for a, b in zip(other, vector)) for other, _ in unique)]
    cases.append({'input': {'profileId': profile_id, 'metricId': kind, 'budgetRub': budget, 'topK': 3},
                  'totalSubsets': 2 ** len(projects), 'feasibleSubsets': feasible, 'frontierSize': len(frontier), 'alternatives': frontier[:3]})
result = {'source': 'Independent Python reference graph and exhaustive search',
          'datasetFileSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'cases': cases}
out = ROOT / 'tests/core/fixtures/optimizer-oracle.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(out)
