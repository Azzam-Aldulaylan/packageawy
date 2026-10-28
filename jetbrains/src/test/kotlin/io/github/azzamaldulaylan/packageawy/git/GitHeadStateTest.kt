package io.github.azzamaldulaylan.packageawy.git

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class GitHeadStateTest {
    @TempDir
    lateinit var root: Path

    private fun write(rel: String, text: String): Path {
        val file = root.resolve(rel)
        Files.createDirectories(file.parent)
        Files.writeString(file, text)
        return file
    }

    @Test
    fun `finds the innermost repository from a nested project`() {
        write("repo/.git/HEAD", "ref: refs/heads/main\n")
        write("repo/.git/refs/heads/main", "aaa\n")
        Files.createDirectories(root.resolve("repo/packages/app"))
        val location = GitHeadState.locate(root.resolve("repo/packages/app"))!!
        assertEquals(root.resolve("repo/.git"), location.gitDir)
        assertEquals("refs/heads/main@aaa", GitHeadState.identity(location))
    }

    @Test
    fun `no repository gives null`() {
        Files.createDirectories(root.resolve("plain"))
        assertNull(GitHeadState.locate(root.resolve("plain")))
    }

    @Test
    fun `reads packed refs and detached heads`() {
        write("r/.git/HEAD", "ref: refs/heads/dev\n")
        write("r/.git/packed-refs", "# pack-refs\nbbb refs/heads/dev\n")
        val location = GitHeadState.locate(root.resolve("r"))!!
        assertEquals("refs/heads/dev@bbb", GitHeadState.identity(location))
        write("r/.git/HEAD", "ccc\n")
        assertEquals("detached:ccc", GitHeadState.identity(location))
    }

    @Test
    fun `follows a linked worktree to its common dir`() {
        write("main/.git/HEAD", "ref: refs/heads/main\n")
        write("main/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n")
        write("main/.git/worktrees/wt/commondir", "../..\n")
        write("main/.git/refs/heads/feature", "ddd\n")
        write("wt/.git", "gitdir: ../main/.git/worktrees/wt\n")
        val location = GitHeadState.locate(root.resolve("wt"))!!
        assertEquals(root.resolve("main/.git/worktrees/wt"), location.gitDir)
        assertEquals(root.resolve("main/.git"), location.commonDir)
        assertEquals("refs/heads/feature@ddd", GitHeadState.identity(location))
    }

    @Test
    fun `watcher fires only when the identity changes`() {
        val head = write("w/.git/HEAD", "ref: refs/heads/main\n")
        val ref = write("w/.git/refs/heads/main", "111\n")
        val location = GitHeadState.locate(root.resolve("w"))!!
        var calls = 0
        val watcher = GitHeadWatcher(location, { calls++ })

        assertFalse(watcher.onPathsChanged(listOf(root.resolve("w/src/index.ts"))))
        assertFalse(watcher.onPathsChanged(listOf(head)))
        Files.writeString(ref, "222\n")
        assertTrue(watcher.onPathsChanged(listOf(ref)))
        Files.writeString(head, "ref: refs/heads/other\n")
        assertTrue(watcher.onPathsChanged(listOf(head)))
        assertEquals(2, calls)
    }
}
