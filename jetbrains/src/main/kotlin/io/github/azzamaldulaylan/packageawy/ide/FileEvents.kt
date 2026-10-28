package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import io.github.azzamaldulaylan.packageawy.files.WatchMatcher
import io.github.azzamaldulaylan.packageawy.git.GitHeadState
import io.github.azzamaldulaylan.packageawy.git.GitHeadWatcher
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/** `files/watch` and `git/watchHead` on one VFS listener per project. */
class FileEvents(project: Project, parent: Disposable) {
    private class FileWatch(val matcher: WatchMatcher, val listener: (String) -> Unit)

    private val fileWatches = CopyOnWriteArrayList<FileWatch>()
    private val headWatches = CopyOnWriteArrayList<GitHeadWatcher>()

    init {
        project.messageBus.connect(parent).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (fileWatches.isEmpty() && headWatches.isEmpty()) return
                val paths = events.flatMap(::pathsOf).distinct()
                if (paths.isEmpty()) return
                ApplicationManager.getApplication().executeOnPooledThread { dispatch(paths) }
            }
        })
    }

    fun watchFiles(baseDir: String, glob: String, listener: (String) -> Unit): AutoCloseable {
        val watch = FileWatch(WatchMatcher(baseDir, glob), listener)
        val request = LocalFileSystem.getInstance().addRootToWatch(baseDir, true)
        loadChildren(watch.matcher.base)
        fileWatches.add(watch)
        return AutoCloseable {
            fileWatches.remove(watch)
            request?.let { LocalFileSystem.getInstance().removeWatchedRoot(it) }
        }
    }

    fun watchGitHead(projectPath: String, onChange: () -> Unit): AutoCloseable? {
        val location = GitHeadState.locate(Path.of(projectPath)) ?: return null
        if (GitHeadState.identity(location) == null) return null
        val watcher = GitHeadWatcher(location, onChange)
        val requests = setOf(location.gitDir, location.commonDir).mapNotNull {
            LocalFileSystem.getInstance().addRootToWatch(it.toString(), true)
        }
        loadChildren(location.gitDir)
        loadChildren(location.commonDir)
        loadChildren(location.commonDir.resolve("refs").resolve("heads"))
        headWatches.add(watcher)
        return AutoCloseable {
            headWatches.remove(watcher)
            requests.forEach { LocalFileSystem.getInstance().removeWatchedRoot(it) }
        }
    }

    private fun dispatch(paths: List<String>) {
        for (watch in fileWatches) {
            for (path in paths) if (watch.matcher.matches(path)) watch.listener(path)
        }
        if (headWatches.isNotEmpty()) {
            val nioPaths = paths.mapNotNull { runCatching { Path.of(it) }.getOrNull() }
            for (watcher in headWatches) watcher.onPathsChanged(nioPaths)
        }
    }

    /** VFS only reports changes under directories whose children it has loaded. */
    private fun loadChildren(dir: Path) {
        ApplicationManager.getApplication().executeOnPooledThread {
            LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir)?.children
        }
    }

    private fun pathsOf(event: VFileEvent): List<String> {
        val paths = mutableListOf(event.path)
        when (event) {
            is VFileMoveEvent -> paths.add(event.oldPath)
            is VFilePropertyChangeEvent -> if (event.isRename) paths.add(event.oldPath)
        }
        return paths
    }
}
