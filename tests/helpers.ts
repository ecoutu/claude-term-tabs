import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const fixture = (name: string): string => join(here, 'fixtures', name)
