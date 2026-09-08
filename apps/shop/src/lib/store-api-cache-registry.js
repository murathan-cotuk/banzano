/**
 * Process-local Maps used by shop /api/store-* routes.
 * Cleared by POST /api/revalidate after sellercentral/backend writes.
 */

const registries = new Map() // name -> { clear: () => void }

export function registerStoreApiCache(name, clearFn) {
  if (!name || typeof clearFn !== "function") return
  registries.set(String(name), { clear: clearFn })
}

export function clearRegisteredStoreApiCaches(names) {
  const list =
    !names || names === "*" || (Array.isArray(names) && names.includes("*"))
      ? [...registries.keys()]
      : Array.isArray(names)
        ? names.map(String)
        : [String(names)]
  const cleared = []
  for (const name of list) {
    const entry = registries.get(name)
    if (!entry) continue
    try {
      entry.clear()
      cleared.push(name)
    } catch (_) {}
  }
  return cleared
}

export function listRegisteredStoreApiCaches() {
  return [...registries.keys()]
}
