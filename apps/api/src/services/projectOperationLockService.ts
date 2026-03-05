interface ActiveProjectLock {
  projectId: string;
  operation: string;
  ownerId: string;
  acquiredAt: string;
}

export interface ProjectLockConflict {
  projectId: string;
  currentOperation: string;
  currentOwnerId: string;
  acquiredAt: string;
}

export class ProjectLockError extends Error {
  readonly conflict: ProjectLockConflict;

  constructor(conflict: ProjectLockConflict) {
    super(
      `Project '${conflict.projectId}' is busy with ${conflict.currentOperation} (owner=${conflict.currentOwnerId})`
    );
    this.name = "ProjectLockError";
    this.conflict = conflict;
  }
}

class ProjectOperationLockService {
  private readonly locks = new Map<string, ActiveProjectLock>();

  acquireOrThrow(input: { projectId: string; operation: string; ownerId: string }): void {
    const existing = this.locks.get(input.projectId);
    if (existing && existing.ownerId !== input.ownerId) {
      throw new ProjectLockError({
        projectId: existing.projectId,
        currentOperation: existing.operation,
        currentOwnerId: existing.ownerId,
        acquiredAt: existing.acquiredAt
      });
    }

    if (!existing) {
      this.locks.set(input.projectId, {
        projectId: input.projectId,
        operation: input.operation,
        ownerId: input.ownerId,
        acquiredAt: new Date().toISOString()
      });
    }
  }

  release(input: { projectId: string; ownerId: string }): void {
    const existing = this.locks.get(input.projectId);
    if (!existing) {
      return;
    }
    if (existing.ownerId !== input.ownerId) {
      return;
    }
    this.locks.delete(input.projectId);
  }
}

export const projectOperationLockService = new ProjectOperationLockService();
