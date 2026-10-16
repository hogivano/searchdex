import { SearchdexError } from '../../domain/index.ts';
import type { DigestCredentials } from '../atlas/digest.ts';

/**
 * Credentials come from the environment and nowhere else.
 *
 * No `--private-key` flag, ever: a flag lands in shell history, in CI logs that
 * echo the command, and in `ps` output. There is no safe way to offer one, so
 * the tool does not.
 */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): DigestCredentials {
  const publicKey = env['ATLAS_PUBLIC_KEY']?.trim();
  const privateKey = env['ATLAS_PRIVATE_KEY']?.trim();

  if (!publicKey || !privateKey) {
    throw new SearchdexError('missing Atlas API credentials', [
      'Set ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY in the environment.',
      'Create a project API key with the "Project Search Index Editor" role',
      '(read-only commands need only "Project Read Only").',
    ]);
  }

  return { publicKey, privateKey };
}
