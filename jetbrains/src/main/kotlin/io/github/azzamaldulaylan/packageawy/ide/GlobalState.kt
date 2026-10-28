package io.github.azzamaldulaylan.packageawy.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.util.concurrency.AppExecutorUtil
import io.github.azzamaldulaylan.packageawy.storage.StateFile
import java.nio.file.Path

/** Where storage files live: the IDE system directory, outside every project. */
object StatePaths {
    val root: Path get() = Path.of(PathManager.getSystemPath(), "packageawy")
    fun global(): Path = root.resolve("global-state.json")
    fun workspace(locationHash: String): Path = root.resolve("workspace").resolve("$locationHash.json")

    val scheduler = AppExecutorUtil.createBoundedScheduledExecutorService("Packageawy state", 1)

    fun open(path: Path): StateFile = StateFile(path, scheduler) { message, error -> logger<StatePaths>().warn(message, error) }
}

/** The `global` storage scope, shared by every project. */
@Service(Service.Level.APP)
class GlobalState : Disposable {
    val file: StateFile = StatePaths.open(StatePaths.global())

    override fun dispose() = file.flush()

    companion object {
        fun getInstance(): GlobalState = ApplicationManager.getApplication().getService(GlobalState::class.java)
    }
}
