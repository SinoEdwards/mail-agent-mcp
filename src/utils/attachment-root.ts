import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function assertInside(root: string, candidate: string): void {
  if (candidate === root || isOutside(root, candidate)) {
    throw new Error(`Attachment path must stay inside configured download root: ${root}`);
  }
}

function assertNotLink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Attachment path contains a symbolic link or junction: ${path}`);
  }
}

function walkDirectory(root: string, targetDirectory: string, create: boolean): void {
  assertInside(root, join(targetDirectory, '.attachment-boundary'));
  const rel = relative(root, targetDirectory);
  let current = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Attachment path contains a symbolic link or junction: ${current}`);
      }
      if (!stat.isDirectory()) throw new Error(`Attachment parent is not a directory: ${current}`);
      continue;
    }
    if (!create) throw new Error(`Attachment parent directory does not exist: ${current}`);
    mkdirSync(current);
  }
  const realDirectory = realpathSync.native(targetDirectory);
  if (isOutside(root, realDirectory)) {
    throw new Error(`Attachment parent escapes configured download root: ${targetDirectory}`);
  }
}

/** Resolve/create the configured root once and use its real path as the trust boundary. */
export function normalizeAttachmentRoot(configuredRoot: string): string {
  if (!configuredRoot.trim()) throw new Error('Attachment download root must not be empty');
  const lexicalRoot = resolve(configuredRoot);
  mkdirSync(lexicalRoot, { recursive: true });
  const stat = lstatSync(lexicalRoot);
  if (!stat.isDirectory()) throw new Error(`Attachment download root is not a directory: ${lexicalRoot}`);
  return realpathSync.native(lexicalRoot);
}

export function attachmentBasename(senderFilename: string): string {
  // Treat both separator styles as hostile input, independently of host OS.
  const leaf = basename(senderFilename.replace(/\\/gu, '/'));
  if (!leaf || leaf === '.' || leaf === '..') throw new Error('Invalid attachment filename');
  return leaf;
}

/**
 * Resolve a caller-selected output under root. Relative paths are root-relative;
 * absolute paths are accepted only when they are already inside root.
 */
export function resolveAttachmentOutputPath(
  configuredRoot: string,
  requestedPath: string | undefined,
  senderFilename: string,
): string {
  const root = normalizeAttachmentRoot(configuredRoot);
  const fallback = attachmentBasename(senderFilename);
  const candidate = resolve(root, requestedPath ?? fallback);
  assertInside(root, candidate);
  walkDirectory(root, dirname(candidate), true);
  assertNotLink(candidate);
  if (existsSync(candidate) && !lstatSync(candidate).isFile()) {
    throw new Error(`Attachment output target is not a regular file: ${candidate}`);
  }
  return candidate;
}

/** Resolve an existing attachment input without following links or junctions. */
export function resolveAttachmentInputPath(configuredRoot: string, requestedPath: string): string {
  const root = normalizeAttachmentRoot(configuredRoot);
  const candidate = resolve(root, requestedPath);
  assertInside(root, candidate);
  walkDirectory(root, dirname(candidate), false);
  assertNotLink(candidate);
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
    throw new Error(`Attachment input is not a regular file: ${candidate}`);
  }
  const realCandidate = realpathSync.native(candidate);
  if (isOutside(root, realCandidate)) {
    throw new Error(`Attachment input escapes configured download root: ${candidate}`);
  }
  return realCandidate;
}
