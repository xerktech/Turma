package com.xerktech.turma.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.polymorphic
import kotlinx.serialization.modules.subclass

/**
 * The one shared JSON decoder for every hub payload and WebSocket frame.
 *
 * - `classDiscriminator = "t"` matches the hub's block tag (`blocks[].t`).
 * - Unknown block types decode to [UnknownBlock] via the polymorphic default,
 *   so a future block kind never crashes the transcript.
 * - `ignoreUnknownKeys` / lenient / `explicitNulls=false` keep decoding robust
 *   across hub versions.
 */
val TurmaJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
    classDiscriminator = "t"
    serializersModule = SerializersModule {
        polymorphic(Block::class) {
            subclass(TextBlock::class)
            subclass(ThinkingBlock::class)
            subclass(ToolUseBlock::class)
            subclass(ToolResultBlock::class)
            subclass(TaskNotificationBlock::class)
            subclass(UnknownBlock::class)
            defaultDeserializer { UnknownBlock.serializer() }
        }
    }
}
