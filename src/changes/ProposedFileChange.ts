export type FileChangeStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "conflicted";

export interface ProposedFileChange {
  readonly id: string;
  readonly uri: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
  readonly originalHash: string | null;
  readonly proposedHash: string | null;
  readonly status: FileChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly conflictReason?: string;
}

export interface FileSystemPort {
  readText(uri: string): Promise<string | null>;
  writeText(uri: string, content: string): Promise<void>;
  deleteFile(uri: string): Promise<void>;
  isDirty(uri: string): boolean;
}
