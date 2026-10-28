package io.github.azzamaldulaylan.packageawy.files

/**
 * VS Code style glob over POSIX relative paths. Supports `**`, `*`, `?`,
 * nested `{a,b}` groups and `[...]` classes. A leading `**` segment also
 * matches zero directories, so `**` then `/package.json` matches the root file.
 */
class Glob(val pattern: String) {
    private val regex: Regex = Regex(toRegex(pattern))

    fun matches(relativePath: String): Boolean = regex.matches(relativePath)

    companion object {
        fun toRegex(glob: String): String {
            val out = StringBuilder()
            var i = 0
            var braceDepth = 0
            while (i < glob.length) {
                val c = glob[i]
                when {
                    c == '*' && glob.startsWith("**", i) -> {
                        val atSegmentStart = i == 0 || glob[i - 1] == '/' || glob[i - 1] == '{' || glob[i - 1] == ','
                        val followedBySlash = i + 2 < glob.length && glob[i + 2] == '/'
                        if (atSegmentStart && followedBySlash) {
                            out.append("(?:.*/)?")
                            i += 3
                        } else {
                            out.append(".*")
                            i += 2
                        }
                        continue
                    }
                    c == '*' -> out.append("[^/]*")
                    c == '?' -> out.append("[^/]")
                    c == '{' -> {
                        braceDepth++
                        out.append("(?:")
                    }
                    c == '}' && braceDepth > 0 -> {
                        braceDepth--
                        out.append(")")
                    }
                    c == ',' && braceDepth > 0 -> out.append("|")
                    c == '[' -> {
                        val end = glob.indexOf(']', i + 1)
                        if (end < 0) {
                            out.append("\\[")
                        } else {
                            var body = glob.substring(i + 1, end)
                            if (body.startsWith("!")) body = "^" + body.substring(1)
                            out.append('[').append(body.replace("\\", "\\\\")).append(']')
                            i = end
                        }
                    }
                    else -> out.append(escapeChar(c))
                }
                i++
            }
            return out.toString()
        }

        private fun escapeChar(c: Char): String = if ("\\.^$|()[]{}+*?".indexOf(c) >= 0) "\\$c" else c.toString()
    }
}
