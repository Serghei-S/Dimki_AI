# OpenStreetMap source snapshots

© OpenStreetMap contributors. Geographic data and derived geographic database are provided under [ODbL 1.0](https://www.openstreetmap.org/copyright).

- `obninsk-center.osm.json`: cached response from `https://overpass-api.de/api/interpreter`, query in `obninsk-center.overpass`. Source database timestamp is recorded inside the response.
- `obninsk-details.osm.xml`: cached OSM API 0.6 response for `https://api.openstreetmap.org/api/0.6/map?bbox=36.606,55.089,36.619,55.0955`, retrieved 2026-10-16.
- `obninsk-details.osm.json`: nodes/ways for lawns, leisure, entrances and gates filtered from that XML. It is not a separate authoritative source.

Source geometry is not an official cadastral survey. The application mixes it with explicitly synthetic population, estimated entrances, pedestrian infill and scenario parameters. Per-feature provenance and source hashes: `../obninsk-center.provenance.json`. Full methodology: `../../docs/OBNINSK_CENTER.md`.

`python tools/fetch_obninsk.py` reuses the cache; `--refresh` explicitly updates it. Rebuild, validate and version the dataset before distributing a refreshed snapshot. Runtime browsing never depends on these public APIs.
