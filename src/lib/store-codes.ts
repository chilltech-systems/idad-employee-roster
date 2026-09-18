import type { Store } from "./model";

export function storeCodeKey(value: string) {
  const compact = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
  const match = compact.match(/^([a-z]+)0*(\d+)$/);
  return match ? `${match[1]}${Number(match[2])}` : compact;
}

export function storeCodeMap(stores: Store[]) {
  const result = new Map<string, Store>();
  for (const store of stores) {
    const key = storeCodeKey(store.id);
    if (result.has(key))
      throw new Error(`Duplicate normalized store code: ${store.id}`);
    result.set(key, store);
  }
  return result;
}
