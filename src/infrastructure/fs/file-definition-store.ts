import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefinitionError } from '../../domain/index.ts';
import type { IndexKey, IndexType, JsonObject, LocalIndex } from '../../domain/index.ts';
import type { DefinitionStore } from '../../application/ports.ts';

/**
 * `search-indexes/<database>.<collection>.<indexName>.json`
 *
 * Flat and predictable: the filename is the index identity, so you can tell what
 * a file is without opening it and `git log` on one path is the history of one
 * index. The trade-off is that a dot in a database or collection name is not
 * representable — rejected loudly on write, and reported as unparseable on read,
 * rather than silently producing the wrong namespace.
 */

/** File body: the definition, plus `type` when it is not the default `search`. */
interface DefinitionFile {
  type?: string;
  [key: string]: unknown;
}

export class FileDefinitionStore implements DefinitionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async load(): Promise<LocalIndex[]> {
    const entries = await readdir(this.#directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    });

    const indexes: LocalIndex[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      indexes.push(await this.#read(entry.name));
    }
    return indexes.sort((a, b) => a.source.localeCompare(b.source));
  }

  async write(key: IndexKey, type: IndexType, definition: JsonObject): Promise<string> {
    const file = join(this.#directory, fileNameFor(key));
    const body: JsonObject = type === 'search' ? definition : { type, ...definition };
    await mkdir(this.#directory, { recursive: true });
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return file;
  }

  async #read(fileName: string): Promise<LocalIndex> {
    const path = join(this.#directory, fileName);
    const key = parseFileName(fileName, path);
    const raw = await readFile(path, 'utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new DefinitionError(path, 'is not valid JSON', [(error as Error).message]);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new DefinitionError(path, 'must contain a JSON object');
    }

    const { type, ...definition } = parsed as DefinitionFile;
    if (type !== undefined && type !== 'search' && type !== 'vectorSearch') {
      throw new DefinitionError(path, `has unknown index type "${type}"`, [
        'Expected "search" or "vectorSearch".',
      ]);
    }

    return {
      key,
      type: (type ?? 'search') as IndexType,
      definition: definition as JsonObject,
      source: path,
    };
  }
}

export function fileNameFor(key: IndexKey): string {
  for (const [label, value] of [
    ['database', key.database],
    ['collection', key.collection],
    ['index name', key.name],
  ] as const) {
    if (value.includes('.')) {
      throw new DefinitionError(
        `${key.database}.${key.collection}.${key.name}`,
        `cannot be stored on disk: the ${label} contains a "." and the filename format is <database>.<collection>.<indexName>.json`,
      );
    }
  }
  return `${key.database}.${key.collection}.${key.name}.json`;
}

export function parseFileName(fileName: string, path: string): IndexKey {
  const parts = fileName.replace(/\.json$/, '').split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new DefinitionError(path, 'does not match <database>.<collection>.<indexName>.json');
  }
  return { database: parts[0]!, collection: parts[1]!, name: parts[2]! };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
