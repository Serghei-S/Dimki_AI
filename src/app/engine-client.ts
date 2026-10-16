import { EngineWorkerClient } from '../core/worker-client.js';
import type { DeepReadonly, DistrictData } from '../core/types.js';
import { DISTRICTS } from './districts.js';
import type { DistrictId } from './districts.js';

export async function connectEngine(
  signal: AbortSignal,
  districtId: DistrictId = 'obninsk-center',
): Promise<{ client: EngineWorkerClient; data: DeepReadonly<DistrictData> }> {
  const response = await fetch(DISTRICTS[districtId].url, { signal });
  if (!response.ok) throw new Error(`Не удалось загрузить район: HTTP ${response.status}`);
  const data = (await response.json()) as DistrictData;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const client = new EngineWorkerClient(
    new Worker(new URL('../core/engine.worker.ts', import.meta.url), { type: 'module' }),
  );
  const abort = () => client.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.init(data);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { client, data };
  } catch (error) {
    client.dispose();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
