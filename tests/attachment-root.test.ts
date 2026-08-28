import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import {
  attachmentBasename,
  normalizeAttachmentRoot,
  resolveAttachmentInputPath,
  resolveAttachmentOutputPath,
} from '../src/utils/attachment-root.js';

describe('attachment root boundary', () => {
  let sandbox: string;
  let root: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mail-agent-attachment-root-'));
    root = join(sandbox, 'downloads');
    mkdirSync(root);
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('normalizes the configured root and creates nested output inside it', () => {
    const normalized = normalizeAttachmentRoot(root);
    const target = resolveAttachmentOutputPath(root, join('nested', 'report.pdf'), 'ignored.pdf');
    expect(target).toBe(join(normalized, 'nested', 'report.pdf'));
    expect(dirname(target)).toBe(join(normalized, 'nested'));
  });

  it.each(['../escape.txt', join('..', 'downloads-sibling', 'escape.txt')])(
    'rejects relative traversal %s',
    (requested) => expect(() => resolveAttachmentOutputPath(root, requested, 'safe.txt')).toThrow(/inside configured download root/i),
  );

  it('rejects an absolute path outside the root and sibling-prefix confusion', () => {
    expect(() => resolveAttachmentOutputPath(root, resolve(sandbox, 'outside.txt'), 'safe.txt')).toThrow(/inside configured download root/i);
    expect(() => resolveAttachmentOutputPath(root, resolve(`${root}-sibling`, 'outside.txt'), 'safe.txt')).toThrow(/inside configured download root/i);
  });

  it('accepts an absolute path only when it is inside the root', () => {
    const requested = resolve(root, 'inside', 'file.txt');
    expect(resolveAttachmentOutputPath(root, requested, 'safe.txt')).toBe(requested);
  });

  it('uses only the basename of sender-controlled filenames for default output', () => {
    expect(attachmentBasename('../../evil.txt')).toBe('evil.txt');
    expect(attachmentBasename('..\\..\\evil.txt')).toBe('evil.txt');
    expect(basename(resolveAttachmentOutputPath(root, undefined, '..\\..\\evil.txt'))).toBe('evil.txt');
  });

  it('rejects a junction or symlink in an output parent', () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside);
    const link = join(root, 'linked');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveAttachmentOutputPath(root, join('linked', 'escape.txt'), 'safe.txt')).toThrow(/symbolic link|junction/i);
  });

  it('rejects a junction or symlink at the output target', () => {
    const outside = join(sandbox, 'outside-target');
    mkdirSync(outside);
    const target = join(root, 'target.txt');
    symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveAttachmentOutputPath(root, 'target.txt', 'safe.txt')).toThrow(/symbolic link|junction/i);
  });

  it('rejects an input file whose parent is a junction or symlink outside root', () => {
    const outside = join(sandbox, 'outside-input');
    mkdirSync(outside);
    const linkedParent = join(root, 'linked-input');
    symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = join(linkedParent, 'secret.txt');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    expect(() => resolveAttachmentInputPath(root, escaped)).toThrow(/symbolic link|junction|inside configured download root/i);
  });

  it('allows a regular input inside root and rejects input traversal', () => {
    const input = join(root, 'uploads', 'safe.txt');
    mkdirSync(dirname(input));
    writeFileSync(input, 'safe');
    expect(resolveAttachmentInputPath(root, join('uploads', 'safe.txt'))).toBe(resolve(input));
    expect(() => resolveAttachmentInputPath(root, resolve(sandbox, 'outside.txt'))).toThrow(/inside configured download root/i);
  });
});
