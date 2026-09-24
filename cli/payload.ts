/**
 * The declaration of every file jen owns in a project it manages.
 *
 * This is data, not logic — readable without running anything, and the single source
 * consumed by both `scripts/stage-payload.js` at pack time and the CLI at install time.
 * Skills are one kind of managed file, not the only kind; nothing below assumes one.
 */

/** The file formats jen can ship. */
export type ManagedFileFormat = 'markdown' | 'yaml' | 'json';

/**
 * The formats with somewhere to put the stamp — frontmatter for markdown, `#` comments
 * for YAML. JSON has neither, so a JSON file can never be recognised as jen's, and can
 * therefore never be a variable-set member.
 */
export const STAMPABLE_FORMATS = ['markdown', 'yaml'] as const satisfies readonly ManagedFileFormat[];

export function isStampable(format: ManagedFileFormat): boolean {
  return (STAMPABLE_FORMATS as readonly ManagedFileFormat[]).includes(format);
}

/** One file, at its three locations: jen's checkout, the staged payload, the project. */
export interface ManagedFile {
  /** Path in jen's own repository, relative to the repository root. */
  source: string;
  /** Path within the staged payload, relative to {@link STAGED_PAYLOAD_DIR}. Tool-neutral. */
  staged: string;
  /** Path in a managed project, relative to the project root. */
  target: string;
  format: ManagedFileFormat;
}

/**
 * A single known location jen always writes. It can never be left orphaned by a later
 * version, so it is never a deletion candidate and carries no stamp.
 */
export interface FixedPath {
  kind: 'fixed';
  file: ManagedFile;
}

/**
 * A group of files jen writes into a directory it shares with the project, where the
 * membership of the group can change between versions. Members are stamped so that a
 * member dropped from a later payload can be told apart from the project's own files.
 */
export interface VariableSet {
  kind: 'variable-set';
  /** Identifier for the set itself, for diagnostics. */
  name: string;
  /** The directory in a managed project the set writes into, shared with the project. */
  targetDir: string;
  members: readonly ManagedFile[];
}

export type PayloadGroup = FixedPath | VariableSet;

/** Where `prepack` stages the payload, relative to the package root. */
export const STAGED_PAYLOAD_DIR = 'dist/templates';

/**
 * The ownership stamp: one namespaced key whose presence — not its value — denotes that
 * jen wrote the file. Constant across releases, because a value that moved per version
 * would rewrite every managed file in every project on every release.
 */
export const STAMP = {
  section: 'metadata',
  key: 'jen',
  value: true,
} as const;

/** The stamp rendered for insertion into YAML frontmatter, trailing newline included. */
export const STAMP_FRONTMATTER = `${STAMP.section}:\n  ${STAMP.key}: ${STAMP.value}\n`;

/**
 * Every skill jen ships into a project.
 *
 * One list, not two. Which of these a pipeline status triggers is a workflow fact, and it
 * already has a home in `AGENTS.md`'s stage table and in the `task-pipeline` capability;
 * recording it a third time here would buy nothing and drift. Nothing that reads this
 * declaration asks the question — staging, installation, and reconciliation all want the
 * skills jen ships, whatever a status does or does not do with them.
 */
export const SKILLS = [
  'refine-epic',
  'design-task',
  'implement-task',
  'review-task',
  'test-task',
  'deliver-task',
] as const;

const SKILLS_TARGET_DIR = '.claude/skills';

function skill(name: string): ManagedFile {
  return {
    source: `${SKILLS_TARGET_DIR}/${name}/SKILL.md`,
    staged: `skills/${name}/SKILL.md`,
    target: `${SKILLS_TARGET_DIR}/${name}/SKILL.md`,
    format: 'markdown',
  };
}

export const PAYLOAD: readonly PayloadGroup[] = [
  {
    kind: 'fixed',
    file: {
      source: 'AGENTS.md',
      staged: 'AGENTS.md',
      target: 'AGENTS.md',
      format: 'markdown',
    },
  },
  {
    kind: 'variable-set',
    name: 'skills',
    targetDir: SKILLS_TARGET_DIR,
    members: SKILLS.map(skill),
  },
];

/**
 * The once-only scaffold: files jen creates when they are absent and the project owns
 * from that moment on.
 *
 * Deliberately beside {@link PAYLOAD} rather than inside it, because the two obey
 * opposite rules. A managed file is overwritten on every run and reconciled against the
 * stamp; a scaffold file is written once and then never read, rewritten, or deleted —
 * not by `update`, and not by `init --force`. Folding them together would make the
 * deletion rule conditional, which is the one rule that must not be.
 *
 * Staged paths are named for the file's role rather than for an assistant, so the staged
 * tree stays tool-neutral even though `.claude/settings.json` is not.
 */
export const SCAFFOLD: readonly ManagedFile[] = [
  {
    source: 'scaffold/registry.yaml',
    staged: 'scaffold/registry.yaml',
    target: 'registry.yaml',
    format: 'yaml',
  },
  {
    source: 'scaffold/settings.json',
    staged: 'scaffold/settings.json',
    target: '.claude/settings.json',
    format: 'json',
  },
];

export interface StagedFile {
  file: ManagedFile;
  /** Whether staging applies the ownership stamp — true for variable-set members only. */
  stamped: boolean;
}

/** Every managed file, flattened out of its group and paired with its stamping rule. */
export function payloadFiles(payload: readonly PayloadGroup[] = PAYLOAD): StagedFile[] {
  return payload.flatMap((group): StagedFile[] =>
    group.kind === 'fixed'
      ? [{ file: group.file, stamped: false }]
      : group.members.map((file) => ({ file, stamped: true })),
  );
}

/**
 * Everything staging writes into {@link STAGED_PAYLOAD_DIR}: the payload, plus the
 * scaffold, which ships alongside it and is never stamped.
 */
export function stagedFiles(
  payload: readonly PayloadGroup[] = PAYLOAD,
  scaffold: readonly ManagedFile[] = SCAFFOLD,
): StagedFile[] {
  return [...payloadFiles(payload), ...scaffold.map((file) => ({ file, stamped: false }))];
}

/** A member's path within its set's target directory, split into segments. */
function withinTargetDir(set: VariableSet, file: ManagedFile): string[] {
  const prefix = `${set.targetDir}/`;
  if (!file.target.startsWith(prefix)) {
    throw new Error(`${file.target} is a member of ${set.name} but does not sit under ${set.targetDir}`);
  }
  return file.target.slice(prefix.length).split('/');
}

/**
 * The path every member of a set occupies below its slot — `SKILL.md` for the shipped
 * skills, where the slot (`design-task`) is what varies between members. Reconciliation
 * derives its search from this rather than hardcoding a filename, so a future variable
 * set is data here and not a code change.
 *
 * Derived from the members themselves, so a set with none has no shape to derive and
 * fails loudly rather than silently reconciling nothing. A member sitting directly in the
 * target directory fails for the same reason: it has no slot, so its shape would come out
 * empty and reconciliation would go looking for directories instead of files.
 */
export function memberShape(set: VariableSet): string {
  const shapes = new Set(
    set.members.map((file) => {
      const segments = withinTargetDir(set, file);
      if (segments.length < 2) {
        throw new Error(
          `${file.target} sits directly in ${set.targetDir}; members of ${set.name} live in a slot below it`,
        );
      }
      return segments.slice(1).join('/');
    }),
  );
  if (shapes.size === 0) {
    throw new Error(`variable set ${set.name} declares no members, so its shape cannot be derived`);
  }
  if (shapes.size > 1) {
    throw new Error(`variable set ${set.name} mixes member shapes (${[...shapes].sort().join(', ')})`);
  }
  return [...shapes][0]!;
}
