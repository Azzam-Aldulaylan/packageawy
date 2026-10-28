package io.github.azzamaldulaylan.packageawy.rpc

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive

/** Typed, validated access to a request's params. Bad input fails with INVALID_PARAMS. */
class Params(private val obj: JsonObject) {

    fun string(name: String): String = optString(name) ?: invalid("$name must be a string")

    fun optString(name: String): String? {
        val value = obj.get(name)?.takeIf { !it.isJsonNull } ?: return null
        if (!value.isJsonPrimitive || !value.asJsonPrimitive.isString) invalid("$name must be a string")
        return value.asString
    }

    /** A watch, progress or process id. Numbers and strings are both accepted and echoed back as sent. */
    fun id(name: String): JsonPrimitive {
        val value = obj.get(name)
        if (value == null || !value.isJsonPrimitive || value.asJsonPrimitive.isBoolean) invalid("$name must be a number or a string")
        return value.asJsonPrimitive
    }

    fun bool(name: String): Boolean {
        val value = obj.get(name)
        if (value == null || !value.isJsonPrimitive || !value.asJsonPrimitive.isBoolean) invalid("$name must be a boolean")
        return value.asBoolean
    }

    fun optInt(name: String): Int? {
        val value = obj.get(name)?.takeIf { !it.isJsonNull } ?: return null
        if (!value.isJsonPrimitive || !value.asJsonPrimitive.isNumber) invalid("$name must be a number")
        return value.asNumber.toInt()
    }

    fun optDouble(name: String): Double? {
        val value = obj.get(name)?.takeIf { !it.isJsonNull } ?: return null
        if (!value.isJsonPrimitive || !value.asJsonPrimitive.isNumber) invalid("$name must be a number")
        return value.asDouble
    }

    fun stringList(name: String): List<String> {
        val value = obj.get(name)
        if (value == null || !value.isJsonArray) invalid("$name must be an array")
        return (value as JsonArray).map {
            if (!it.isJsonPrimitive || !it.asJsonPrimitive.isString) invalid("$name must contain strings")
            it.asString
        }
    }

    fun objectList(name: String): List<Params> {
        val value = obj.get(name)
        if (value == null || !value.isJsonArray) invalid("$name must be an array")
        return (value as JsonArray).map {
            if (!it.isJsonObject) invalid("$name must contain objects")
            Params(it.asJsonObject)
        }
    }

    fun obj(name: String): Params = optObj(name) ?: invalid("$name must be an object")

    fun optObj(name: String): Params? {
        val value = obj.get(name)?.takeIf { !it.isJsonNull } ?: return null
        if (!value.isJsonObject) invalid("$name must be an object")
        return Params(value.asJsonObject)
    }

    /** Any JSON value, or null when absent. */
    fun raw(name: String): JsonElement? = obj.get(name)?.takeIf { !it.isJsonNull }

    companion object {
        fun of(element: JsonElement?): Params {
            if (element == null || !element.isJsonObject) invalid("params must be an object")
            return Params(element.asJsonObject)
        }

        fun invalid(message: String): Nothing = throw ResponseError(ErrorCodes.INVALID_PARAMS, message)
    }
}
