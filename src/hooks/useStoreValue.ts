import { useSyncExternalStore } from 'react';
import type { Store } from '../lib/store';

/** ストアの値（またはその一部）を購読する。selector は数値や文字列などの原始値を返すこと。 */
export function useStoreValue<T, S = T>(store: Store<T>, selector?: (v: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => (selector ? selector(store.get()) : (store.get() as unknown as S)),
  );
}
