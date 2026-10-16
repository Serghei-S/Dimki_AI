import centerUrl from '../../data/obninsk-center.json?url';
import syntheticUrl from '../../data/district.json?url';
export type DistrictId = 'obninsk-center' | 'sosnovy';
export const DISTRICTS = {
  'obninsk-center': {
    url: centerUrl,
    datasetId: 'obninsk-center-01',
    name: 'Центр Обнинска',
    description: 'Площадь Преображения · проспект Ленина',
    real: true,
    mapUrl: 'https://www.openstreetmap.org/#map=17/55.09225/36.61250',
  },
  sosnovy: {
    url: syntheticUrl,
    datasetId: 'obninsk-fictional-district-01',
    name: 'Сосновый',
    description: 'Прежний учебный район',
    real: false,
    mapUrl: null,
  },
} as const;
