import fs from 'node:fs/promises'
import path from 'node:path'

const registryPath = path.resolve(process.env.REGISTRY_PATH || 'server/data/registry.json')
const keyFor = (spreadsheetId, sheetName) => `${spreadsheetId}::${sheetName}`

async function readRegistry() {
  try { return JSON.parse(await fs.readFile(registryPath, 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

export async function saveAssemblyRef(spreadsheetId, sheetName, ref) {
  const registry = await readRegistry()
  registry[keyFor(spreadsheetId, sheetName)] = { ...ref, updatedAt: new Date().toISOString() }
  await fs.mkdir(path.dirname(registryPath), { recursive: true })
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
}

export async function getAssemblyRef(spreadsheetId, sheetName) {
  const registry = await readRegistry()
  if (sheetName) return registry[keyFor(spreadsheetId, sheetName)] ?? null
  const prefix = `${spreadsheetId}::`
  const match = Object.entries(registry).find(([key]) => key.startsWith(prefix))
  return match?.[1] ?? null
}
