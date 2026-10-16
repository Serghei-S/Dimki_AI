import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
sys.path.insert(0,str(ROOT/'.tools/geo'))
try:
    from validate_obninsk import validate_geometry
    GEO_AVAILABLE=True
except ImportError:
    GEO_AVAILABLE=False

@unittest.skipUnless(GEO_AVAILABLE,'Install tools/requirements-geo.txt to run the real-map geometry audit')
class ObninskGeometryTests(unittest.TestCase):
    def test_all_scenarios_have_valid_geometry_and_no_unmarked_barrier_crossings(self):
        data=json.loads((ROOT/'data/obninsk-center.json').read_text(encoding='utf-8'))
        report=validate_geometry(data)
        self.assertTrue(report['valid'],'\n'.join(report['errors']))
        self.assertEqual(len(report['scenarios']),6)
        self.assertEqual(len(set(s['population'] for s in report['scenarios'])),1)

    def test_corrupted_geometry_is_detected(self):
        data=json.loads((ROOT/'data/obninsk-center.json').read_text(encoding='utf-8'))
        edge=next(e for e in data['edges'] if e['active'])
        edge['geometry'][0][0]+=20
        self.assertFalse(validate_geometry(data)['valid'])
