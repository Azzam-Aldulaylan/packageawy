package io.github.azzamaldulaylan.packageawy.ide

import io.github.azzamaldulaylan.packageawy.sidecar.WorkspaceFolder

/** Keeps initialization snapshots and queued root updates local to their session. */
internal class SessionWorkspaceFolders(private val lock: Any) {
    private var folders: List<WorkspaceFolder> = emptyList()

    fun initialize(snapshot: List<WorkspaceFolder>): List<WorkspaceFolder> {
        synchronized(lock) { folders = snapshot }
        return snapshot
    }

    fun update(next: List<WorkspaceFolder>, isCurrent: () -> Boolean, notify: (List<WorkspaceFolder>) -> Unit) {
        synchronized(lock) {
            if (!isCurrent() || next == folders) return
            folders = next
            notify(next)
        }
    }
}
