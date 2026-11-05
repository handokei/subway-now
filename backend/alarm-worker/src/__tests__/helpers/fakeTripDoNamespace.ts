/**
 * #3300 PR-2 — TripDO 테스트용 fake namespace / storage.
 *
 * - `makeMapStorage`: Map 기반 `TripDoStorage`. `gap`이 켜지면 get/put 앞에서 macrotask 양보를 끼워
 *   "storage 외 await가 있는 핸들러" 또는 "mutex 없는 클래스"의 interleave를 결정적으로 재현한다.
 * - `makeFakeTripDoNamespace`: `idFromName`/`get` → 이름별 TripDO 인스턴스. `serializeRequests`(기본 true)는
 *   프로덕션 DO 런타임의 요청 직렬화를 흉내낸다. 끄면 TripDO 클래스 자체 mutex만으로 직렬화되는지 검증할 수 있다.
 */
import { TripDO, type TripDoStorage } from '../../tripDO';

const yieldMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface MapStorageOptions {
  /** true면 get/put 각각 앞에서 macrotask를 양보한다. */
  gap?: boolean;
}

export type MapStorage = TripDoStorage & { map: Map<string, unknown> };

export function makeMapStorage(options: MapStorageOptions = {}): MapStorage {
  const map = new Map<string, unknown>();
  const pause = async (): Promise<void> => {
    if (options.gap) await yieldMacrotask();
  };
  const storage = {
    map,
    get: async (key: string) => {
      await pause();
      return map.get(key);
    },
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      await pause();
      if (typeof keyOrEntries === 'string') {
        map.set(keyOrEntries, value);
        return;
      }
      for (const [key, entryValue] of Object.entries(keyOrEntries)) map.set(key, entryValue);
    },
  };
  return storage as unknown as MapStorage;
}

export interface FakeTripDoNamespaceOptions extends MapStorageOptions {
  serializeRequests?: boolean;
}

export function makeFakeTripDoNamespace(options: FakeTripDoNamespaceOptions = {}) {
  const { serializeRequests = true } = options;
  const instances = new Map<string, TripDO>();
  const storages = new Map<string, MapStorage>();
  const chains = new Map<string, Promise<unknown>>();

  const ns = {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id.toString();
      let instance = instances.get(name);
      if (!instance) {
        const storage = makeMapStorage(options);
        storages.set(name, storage);
        instance = new TripDO({ storage } as unknown as DurableObjectState);
        instances.set(name, instance);
      }
      const target = instance;
      return {
        fetch: (request: Request): Promise<Response> => {
          if (!serializeRequests) return target.fetch(request);
          const run = (chains.get(name) ?? Promise.resolve()).then(() => target.fetch(request));
          chains.set(
            name,
            run.catch(() => undefined),
          );
          return run;
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { ns, instances, storages };
}
