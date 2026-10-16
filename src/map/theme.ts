/** Base cartography. Analytical colors live separately in palette.ts / flow-layer.ts. */
export const GIS_THEME = {
  background: '#e9eef2',
  ground: '#dce3e8',
  block: '#e0e6e3',
  road: '#a0aab5',
  marking: '#f7f9fc',
  path: '#f1f4f7',
  lawn: '#c3d5b8',
  publicGround: '#dce2e7',
  residential: ['#e4eaf0', '#d9e2eb', '#eaf0f5', '#dfe6ec', '#d5dfe8'],
  school: '#d4deeb',
  clinic: '#d0e1e9',
  civic: '#dde4ec',
  roof: '#f7f9fc',
  selection: '#1261ed',
  selectionHalo: '#76aaff',
  marker: '#6383aa',
} as const;
