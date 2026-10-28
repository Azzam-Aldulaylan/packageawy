package io.github.azzamaldulaylan.packageawy.git

import java.nio.file.Path

/** Calls [onChange] when the identity of HEAD changes after a relevant file event. */
class GitHeadWatcher(
    val location: GitLocation,
    private val onChange: () -> Unit,
    private val readIdentity: (GitLocation) -> String? = GitHeadState::identity,
) {
    private var identity: String? = readIdentity(location)

    /** Feed every changed path. Returns true when HEAD moved and [onChange] ran. */
    @Synchronized
    fun onPathsChanged(paths: Collection<Path>): Boolean {
        if (paths.none(location::affects)) return false
        val next = readIdentity(location)
        if (next == identity) return false
        identity = next
        onChange()
        return true
    }
}
