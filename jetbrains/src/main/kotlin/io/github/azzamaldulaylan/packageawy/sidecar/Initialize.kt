package io.github.azzamaldulaylan.packageawy.sidecar

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import io.github.azzamaldulaylan.packageawy.rpc.JsonRpcConnection
import java.nio.file.Path

data class WorkspaceFolder(val id: String, val name: String, val path: String) {
    fun toJson(): JsonObject = JsonObject().apply {
        addProperty("id", id)
        addProperty("name", name)
        addProperty("path", path)
    }

    companion object {
        /** The id is the folder's file URI, which stays the same across sessions. */
        fun of(path: Path): WorkspaceFolder {
            val absolute = path.toAbsolutePath().normalize()
            val uri = absolute.toUri().toString().removeSuffix("/")
            return WorkspaceFolder(uri, absolute.fileName?.toString() ?: absolute.toString(), absolute.toString())
        }

        fun toJson(folders: List<WorkspaceFolder>): JsonArray = JsonArray().apply { folders.forEach { add(it.toJson()) } }
    }
}

object Initialize {
    fun params(
        folders: List<WorkspaceFolder>,
        trusted: Boolean,
        settings: Map<String, Any>,
        workspaceState: JsonObject,
        globalState: JsonObject,
    ): JsonObject = JsonObject().apply {
        add("workspaceFolders", WorkspaceFolder.toJson(folders))
        addProperty("isWorkspaceTrusted", trusted)
        add("settings", JsonRpcConnection.toJson(settings))
        add("workspaceState", workspaceState)
        add("globalState", globalState)
    }
}
